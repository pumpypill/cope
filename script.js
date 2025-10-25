(function () {
	'use strict';

	// Helper: strip // and /* */ comments from JSON so JSON with header comments still parses
	function stripJsonComments(text) {
		// Remove /* block */ comments
		const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
		// Remove // line comments (but keep protocol-like patterns intact by requiring start or non-colon before //)
		return withoutBlock.replace(/(^|[^:])\/\/.*$/gm, '$1');
	}

	// Add detection for file:// protocol and show warning
	function detectLocalFileUsage() {
		if (window.location.protocol === 'file:') {
			console.warn('⚠️ Application loaded via file:// protocol. JSON loading will likely fail due to CORS restrictions.');
			return true;
		}
		return false;
	}

	// Helper to load JSON with better error handling - modified to work with file:// protocol
	async function loadJsonFile(url) {
		try {
			// Even if we're using file:// protocol, try to load the JSON directly
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP error! Status: ${response.status}`);
			}
			const text = await response.text();
			return JSON.parse(stripJsonComments(text));
		} catch (e) {
			// If fetch fails (likely due to file:// protocol), try to use a synchronous XHR as fallback
			// This is a hack but it often works with local files
			console.warn(`Error loading ${url} with fetch, trying XHR fallback:`, e);
			return new Promise((resolve, reject) => {
				try {
					const xhr = new XMLHttpRequest();
					xhr.open('GET', url, true);
					xhr.onload = function() {
						if (xhr.status === 200) {
							try {
								const data = JSON.parse(stripJsonComments(xhr.responseText));
								resolve(data);
							} catch (parseError) {
								reject(new Error(`Failed to parse ${url}: ${parseError.message}`));
							}
						} else {
							reject(new Error(`XHR request failed with status ${xhr.status}`));
						}
					};
					xhr.onerror = function() {
						reject(new Error('XHR request failed'));
					};
					xhr.send();
				} catch (xhrError) {
					reject(xhrError);
				}
			});
		}
	}

	// New: ResponseEngine for selecting sarcastic replies from input/output JSON
	class ResponseEngine {
		constructor() {
			this.ready = false;
			this.prompts = [];
			this.outputs = [];
			this.map = new Map(); // prompt -> responses[]
			this.used = new Map(); // prompt -> Set(usedIndices)
			this.allResponses = [];
			this.genericFallback = []; // Removed fallbacks for testing

			// === BEGIN: lightweight "brain" augmentation state ===
			this.brainEnabled = true;

			// Recent reply de-dup within session
			this.recentReplies = [];
			this.RECENT_CAP = 12;

			// Tiny synonyms map (very conservative to preserve tone)
			this.synonyms = {
				stop: ['quit', 'halt'],
				risk: ['risk', 'exposure'],
				plan: ['plan', 'rules'],
				rules: ['rules', 'guardrails'],
				exit: ['exit', 'sell'],
				journal: ['journal', 'log'],
				feelings: ['feelings', 'emotions'],
				greed: ['greed', 'ego'],
				wait: ['wait', 'hold'],
				buy: ['buy', 'enter'],
				sell: ['sell', 'exit']
			};

			// Short intros (prefixes) and outros (checklist nudges)
			this.introTemplates = {
				asset: ['Re {asset}:', '{asset}, huh:', 'On {asset}:'],
				theme: ['On {theme}:', 'For {theme}:']
			};
			this.outros = {
				risk: ['Guardrail: size small.', 'Cap risk, then click.'],
				revenge: ['No revenge trades today.', 'Walk away.'],
				sleep: ['Sleep > screen.', 'Screens off after this.'],
				budget: ['Bills before bets.', 'Rent stays sacred.'],
				journal: ['Log it, then leave it.', 'Write, don’t re-enter.'],
				exit: ['Take the exit you planned.', 'Scale out, not up.'],
				size: ['1–3% max size.', 'Tiny size or no trade.'],
				discipline: ['Obey the stop.', 'Rules over vibes.'],
				emotions: ['Decide when calm.', 'Trade logic, not feelings.']
			};
			// === END: lightweight "brain" augmentation state ===
		}

		async init() {
			try {
				// Use the new helper function for loading JSON
				const [prompts, outputs] = await Promise.all([
					loadJsonFile('./input.json'),
					loadJsonFile('./output.json')
				]);

				this.prompts = Array.isArray(prompts) ? prompts : [];
				this.outputs = Array.isArray(outputs) ? outputs : [];
				this.outputs.forEach(o => this.map.set(o.prompt, o.responses || []));
				this.allResponses = this.outputs.flatMap(o => o.responses || []);
				this.ready = true;
				console.log("ResponseEngine: Successfully loaded", this.prompts.length, "prompts and", this.outputs.length, "output entries");
			} catch (e) {
				console.warn('ResponseEngine: failed to load input/output JSON.', e);
				this.ready = false;
			}
		}

		tokenize(s) {
			return (s || '')
				.toLowerCase()
				.replace(/[^a-z0-9$ ]+/g, ' ')
				.split(/\s+/)
				.filter(Boolean);
		}

		score(msg, prompt) {
			const a = new Set(this.tokenize(msg));
			const b = new Set(this.tokenize(prompt));
			if (!a.size || !b.size) return 0;
			let overlap = 0;
			for (const t of a) if (b.has(t)) overlap++;
			return overlap / Math.sqrt(a.size * b.size);
		}

		findBestPrompt(message) {
			let best = { prompt: null, score: 0 };
			for (const { prompt } of this.outputs) {
				const s = this.score(message, prompt);
				if (s > best.score) best = { prompt, score: s };
			}
			return best.score > 0 ? best.prompt : null;
		}

		pickFromPrompt(prompt) {
			const list = this.map.get(prompt) || [];
			if (!list.length) return null;
			const used = this.used.get(prompt) || new Set();
			const available = list
				.map((_, i) => i)
				.filter(i => !used.has(i));
			const idx = (available.length ? available : list.map((_, i) => i))[Math.floor(Math.random() * (available.length || list.length))];
			used.add(idx);
			if (used.size >= list.length) used.clear(); // reset cycle
			this.used.set(prompt, used);
			return list[idx];
		}

		// === BEGIN: augmentation helpers ===
		_hash(s) {
			let h = 2166136261 >>> 0;
			for (let i = 0; i < s.length; i++) {
				h ^= s.charCodeAt(i);
				h = Math.imul(h, 16777619);
			}
			return h >>> 0;
		}
		_dayOfYear() {
			const now = new Date();
			const start = new Date(now.getFullYear(), 0, 0);
			const diff = now - start;
			return Math.floor(diff / 86400000); // ms per day
		}
		_rng(seed) {
			// Mulberry32
			let t = seed >>> 0;
			return () => {
				t += 0x6D2B79F5;
				let r = Math.imul(t ^ (t >>> 15), 1 | t);
				r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
				return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
			};
		}
		_pick(rng, arr) {
			return arr[Math.floor(rng() * arr.length)];
		}
		_chance(rng, p) {
			return rng() < p;
		}
		_detectThemes(msg) {
			const m = msg.toLowerCase();
			const themes = [];
			const add = (t) => { if (!themes.includes(t)) themes.push(t); };

			const hasAny = (words) => words.some(w => m.includes(w));

			if (hasAny(['revenge', 'win it back', 'get it back', 'tilt'])) add('revenge');
			if (hasAny(['rent', 'bills', 'budget', 'debt', 'credit'])) add('budget');
			if (hasAny(['sleep', 'insomnia', 'screen time', 'burnout'])) add('sleep');
			if (hasAny(['journal', 'log', 'review'])) add('journal');
			if (hasAny(['exit', 'take profit', 'tp', 'ladder', 'scale out'])) add('exit');
			if (hasAny(['size', 'all-in', 'position size'])) add('size');
			if (hasAny(['discipline', 'rules', 'rule', 'checklist', 'boundary'])) add('discipline');
			if (hasAny(['feel', 'feeling', 'emotions', 'shame', 'fomo', 'fear', 'greed'])) add('emotions');
			if (hasAny(['risk', 'stop', 'stop-loss', 'stoploss', 'max loss'])) add('risk');

			return themes;
		}
		_detectEntities(msg) {
			const amounts = [];
			const people = [];
			let asset = null;

			// $TICKER like patterns
			const mAsset = msg.match(/\$[A-Za-z][A-Za-z0-9]{1,15}/);
			if (mAsset) asset = mAsset[0];

			// amounts like 2k, $150k, 1.8k, 3m
			const numRe = /\$?\b\d+(\.\d+)?\s*(k|m|b)?\b/ig;
			let m;
			while ((m = numRe.exec(msg)) !== null) amounts.push(m[0]);

			// relationship/work hints (used only for intro flavor)
			if (/\bwife|husband|partner|family\b/i.test(msg)) people.push('family');
			if (/\bboss|manager|job|work|hr|meeting\b/i.test(msg)) people.push('work');

			const themes = this._detectThemes(msg);
			return { asset, amounts, people, themes };
		}
		_applySynonyms(rng, text) {
			// Replace up to 2 words with synonyms (10–30% chance each place)
			const maxRepl = 2;
			let count = 0;
			const words = text.split(/\b/);
			for (let i = 0; i < words.length && count < maxRepl; i++) {
				const w = words[i];
				const key = w.toLowerCase();
				if (this.synonyms[key] && this._chance(rng, 0.25)) {
					const repl = this._pick(rng, this.synonyms[key]);
					// Preserve capitalization if original was capitalized
					words[i] = /^[A-Z]/.test(w) ? repl.charAt(0).toUpperCase() + repl.slice(1) : repl;
					count++;
				}
			}
			return words.join('');
		}
		_intro(rng, ents) {
			if (ents.asset) {
				const t = this._pick(rng, this.introTemplates.asset);
				return t.replace('{asset}', ents.asset);
			}
			if (ents.themes && ents.themes.length) {
				const theme = ents.themes[0];
				const t = this._pick(rng, this.introTemplates.theme);
				return t.replace('{theme}', theme);
			}
			// light flavor for common contexts if nothing else
			if (ents.people.includes('family')) return this._pick(rng, ['For home:', 'On family:']);
			if (ents.people.includes('work')) return this._pick(rng, ['On work:', 'For the job:']);
			return null;
		}
		_outro(rng, ents) {
			const pools = ents.themes?.map(t => this.outros[t]).filter(Boolean) || [];
			const pool = pools.length ? pools.flat() : null;
			return pool ? this._pick(rng, pool) : null;
		}
		_varyPunct(rng, text) {
			if (this._chance(rng, 0.3)) {
				// swap one period for an em-dash if present
				const idx = text.indexOf('.');
				if (idx > -1) return text.slice(0, idx) + ' —' + text.slice(idx + 1).trimStart();
			}
			// ensure it ends with punctuation
			if (!/[.!?]$/.test(text)) return text + '.';
			return text;
		}
		_composeWithCaps(prefix, core, suffix, maxLen = 200) {
			const parts = [];
			if (prefix) parts.push(prefix);
			if (core) parts.push(core);
			if (suffix) parts.push(suffix);
			let out = parts.filter(Boolean).join(' ');
			// Trim if too long: drop suffix first, then prefix
			if (out.length > maxLen && suffix) {
				out = [prefix, core].filter(Boolean).join(' ');
			}
			if (out.length > maxLen && prefix) {
				out = core || '';
			}
			return out.slice(0, maxLen);
		}
		_augment(message, base) {
			try {
				const seed = this._hash(String(message || '')) ^ this._dayOfYear();
				const rng = this._rng(seed);
				const ents = this._detectEntities(message);

				// style is very light—only affects synonym aggressiveness and punctuation variance
				const style = this._pick(rng, ['blunt', 'coach', 'deadpan']);

				let line = base;
				// Very conservative synonym pass
				if (this._chance(rng, style === 'blunt' ? 0.2 : 0.35)) {
					line = this._applySynonyms(rng, line);
				}
				line = this._varyPunct(rng, line);

				const intro = this._chance(rng, ents.asset ? 0.9 : ents.themes.length ? 0.7 : 0.25)
					? this._intro(rng, ents)
					: null;

				const outro = this._chance(rng, ents.themes.length ? 0.7 : 0.35)
					? this._outro(rng, ents)
					: null;

				const composed = this._composeWithCaps(intro, line, outro, 200);
				return composed || base;
			} catch {
				return base;
			}
		}
		_isRecent(s) {
			return this.recentReplies.includes(s);
		}
		_pushRecent(s) {
			this.recentReplies.push(s);
			if (this.recentReplies.length > this.RECENT_CAP) this.recentReplies.shift();
		}
		// === END: augmentation helpers ===

		getReply(message) {
			if (!this.ready) return "[JSON files not loaded - check console]";

			// Original selection
			const best = this.findBestPrompt(message);
			let base = null;

			if (best) base = this.pickFromPrompt(best);
			if (!base && this.allResponses.length) {
				base = this.allResponses[Math.floor(Math.random() * this.allResponses.length)];
			}
			if (!base) return "[No matching response found - JSON may be empty]";

			// Apply augmentation
			let final = this.brainEnabled ? this._augment(message, base) : base;

			// De-dup against recent; retry a few times if collision
			if (this._isRecent(final)) {
				for (let i = 0; i < 2; i++) {
					const alt = best ? this.pickFromPrompt(best) : null;
					if (alt && alt !== base) {
						const candidate = this.brainEnabled ? this._augment(message, alt) : alt;
						if (!this._isRecent(candidate)) {
							final = candidate;
							break;
						}
					}
				}
			}

			this._pushRecent(final);
			return final;
		}
	}

	class Scheduler {
		constructor() {
			this.tasks = []; // {id, executeAt, cb}
			this.mainTimer = null;
			this.worker = null;
			this._initWorker();
			document.addEventListener('visibilitychange', () => this.checkDueTasks());
			// also check periodically in case worker is throttled
			this._fallbackTick = setInterval(() => this.checkDueTasks(), 2000);
		}
		_initWorker() {
			try {
				const code = `
					// worker: post a tick every second
					setInterval(() => postMessage(Date.now()), 1000);
				`;
				const blob = new Blob([code], { type: 'application/javascript' });
				this.worker = new Worker(URL.createObjectURL(blob));
				this.worker.onmessage = () => this.checkDueTasks();
			} catch (e) {
				console.warn('Scheduler: worker unavailable, falling back to timers', e);
				this.worker = null;
			}
		}
		schedule(cb, delayMs) {
			const id = Math.random().toString(36).slice(2, 9);
			const executeAt = Date.now() + Math.max(0, Number(delayMs) || 0);
			this.tasks.push({ id, executeAt, cb });
			this._rescheduleMainTimer();
			return id;
		}
		clear(id) {
			if (!id) return;
			this.tasks = this.tasks.filter(t => t.id !== id);
			this._rescheduleMainTimer();
		}
		checkDueTasks() {
			const now = Date.now();
			const due = this.tasks.filter(t => t.executeAt <= now);
			if (due.length) {
				// run in order
				due.sort((a, b) => a.executeAt - b.executeAt).forEach(t => {
					try { t.cb(); } catch (e) { console.error('Scheduled task error', e); }
				});
				this.tasks = this.tasks.filter(t => t.executeAt > now);
			}
			this._rescheduleMainTimer();
		}
		_rescheduleMainTimer() {
			if (this.mainTimer) {
				clearTimeout(this.mainTimer);
				this.mainTimer = null;
			}
			if (!this.tasks.length) return;
			// next earliest
			const nextAt = this.tasks.reduce((m, t) => Math.min(m, t.executeAt), Infinity);
			const delay = Math.max(0, nextAt - Date.now());
			// schedule a short main-thread timeout to guarantee eventual execution
			this.mainTimer = setTimeout(() => this.checkDueTasks(), delay + 10);
		}
		destroy() {
			if (this.worker) { this.worker.terminate(); this.worker = null; }
			if (this.mainTimer) { clearTimeout(this.mainTimer); this.mainTimer = null; }
			if (this._fallbackTick) { clearInterval(this._fallbackTick); this._fallbackTick = null; }
			this.tasks = [];
		}
	}

	class TerminalApp {
		constructor() {
			this.input = document.getElementById('terminal-input');
			this.output = document.getElementById('output');

			if (!this.input || !this.output) {
				console.error('Terminal elements not found: #terminal-input or #output');
				return;
			}

			// Identity
			this.userId = this.generateUserId();
			this.updatePrompts();

			// Storage
			this.STORAGE_KEY = 'pumpfessions';
			this.confessions = this.loadConfessions();

			// Preloaded feed - will be loaded from input.json
			this.preloadedConfessions = [];
			this.displayedConfessions = new Set();
			this._autoFeedStarted = false; // guard to avoid double-start

			// Timing
			this.STARTUP_FEED_DELAY = 3000; // Reduced from 5000ms to 3000ms
			this.MIN_INTERVAL = 15000;
			this.MAX_INTERVAL = 45000;
			this.LOADING_DELAY = 2000;
			this.MAX_FIRST_ITEM_WAIT = 12000; // Maximum wait for first item (15s - 3s startup)
			// Thinking delay (applies to preloaded feed and user submissions)
			this.THINKING_DELAY_MIN = 800;
			this.THINKING_DELAY_MAX = 2000;

			// Add loading tracker
			this._feedItemShown = false;
			this._initialLoadTimer = null;

			// New: response engine and preload initialization
			this.responseEngine = new ResponseEngine();
			this.initPreloadedData();

			// New scheduler instance used for thinking/auto-feed timers
			this.scheduler = new Scheduler();

			// NEW: track the last user confession still "thinking"
			this.pendingUserReply = null;

			// Commands
			this.commands = {
				help: () => this.showHelp(),
				cope: (msg) => this.copeAndDisplay(msg),
				feed: () => this.showFeed(),
				clear: () => this.clearTerminal(),
				about: () => this.showAbout()
			};

			this.initEvents();
			this.clearTerminal();
			// Ensure auto-feed starts even if JSON fails or is delayed
			this.ensureAutoFeedStarted();
		}

		// Ensure auto-feed is scheduled exactly once
		ensureAutoFeedStarted() {
			if (this._autoFeedStarted) return;
			this._autoFeedStarted = true;
			
			// Start auto-feed sooner
			setTimeout(() => this.startAutoFeed(), this.STARTUP_FEED_DELAY);
			
			// Set a maximum wait timer to force first item to appear within 15 seconds total
			this._initialLoadTimer = setTimeout(() => {
				if (!this._feedItemShown) {
					console.log("Max wait time reached, forcing first feed item to appear");
					this.showForcedFirstItem();
				}
			}, this.STARTUP_FEED_DELAY + this.MAX_FIRST_ITEM_WAIT);
		}

		// New method to show a fallback item if JSON loading is too slow
		showForcedFirstItem() {
			const fallbackConfession = {
				message: "Sold my wife's wedding ring for TROLL. She found out when I couldn't afford this month's rent. Moving out tomorrow.",
				userId: "user@" + Math.random().toString(36).substring(2, 10),
				displayTime: new Date().toLocaleString()
			};
			
			this.addLine("Displaying initial feed item...");
			this.renderConfession(fallbackConfession);
			this._feedItemShown = true;
			
			// If timer still exists, clear it
			if (this._initialLoadTimer) {
				clearTimeout(this._initialLoadTimer);
				this._initialLoadTimer = null;
			}
		}

		// Load preloaded confessions from input.json
		async initPreloadedData() {
			try {
				console.log('Attempting to load confessions from input.json...');
				// Use the new helper function that works with file:// protocol
				const data = await loadJsonFile('./input.json');
				console.log('Raw data from input.json:', data);
				
				if (Array.isArray(data)) {
					this.preloadedConfessions = data;
					console.log(`Successfully loaded ${this.preloadedConfessions.length} confessions from input.json`);
					// Log the first few to verify content
					console.log('First 3 confessions:', this.preloadedConfessions.slice(0, 3));
					// If first item hasn't been shown yet but JSON loaded successfully,
					// show the first item right away instead of waiting
					if (!this._feedItemShown) {
						this.showFirstItemImmediately();
					}
				} else {
					console.error('Input.json does not contain an array', data);
					throw new Error('Input.json format invalid');
				}
			} catch (err) {
				console.error('Failed to load confessions from input.json:', err);
				
				// Always fall back to hard-coded values from input.json
				console.log('Using hardcoded fallback confessions from input.json');
				this.preloadedConfessions = [
					"Cope terminal, turned $2k into $150k on TROLL then back to $1.8k during a Zoom. Need a detox from charts and a reset routine.",
					"Been averaging down on Cupsey for months; wife thinks it's vacation savings. How do I confess and stop adding on every red candle?",
					"Unstable coin paid me in hypertension. Request: discipline rebuild plan and a budget that survives FOMO.",
					"Sold my car for BAGWORK 'support' that wasn't there. How do I stop calling dips that turn into cliffs?",
					"$Runner had me sprinting to the bottom. Give me a one-page risk plan for small accounts that doesn't need miracles."
				];
				console.log(`Added ${this.preloadedConfessions.length} fallback confessions`);
			} finally {
				// Initialize response engine regardless of success/failure
				this.responseEngine.init();
				// Guarantee auto-feed is running
				this.ensureAutoFeedStarted();
			}
		}

		// Fixed: Simplified generateUserId function to avoid stack overflow
		generateUserId() {
			const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
			let id = '';
			for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
			return `user@${id}`;
		}

		updatePrompts() {
			document.querySelectorAll('.prompt').forEach(el => {
				el.textContent = `${this.userId}:~$ `;
			});
		}

		initEvents() {
			this.input.addEventListener('keydown', (e) => {
				if (e.key !== 'Enter') return;
				const raw = this.input.value;
				const value = raw.trim();
				this.addLine(`${this.userId}:~$ ${raw}`, 'command');
				this.input.value = '';
				if (!value) return;

				const [cmd, ...rest] = value.split(' ');
				const arg = rest.join(' ');
				const handler = this.commands[cmd.toLowerCase()];
				if (!handler) {
					this.addLine(`Command not found: ${cmd}`, 'error');
					this.addLine(`Type "help" for available commands`, 'output-line');
					return;
				}
				try {
					handler(arg);
				} catch (err) {
					console.error(err);
					this.addLine('Command execution failed', 'error');
				}
			});
			document.addEventListener('click', () => this.input.focus());
		}

		addLine(text, className = 'output-line') {
			const line = document.createElement('div');
			line.className = `line ${className}`;
			line.textContent = text;
			this.output.appendChild(line);
			this.output.scrollTop = this.output.scrollHeight;
			return line;
		}

		showHelp() {
			[
				'Available commands:',
				'  cope <message>    - Post an anonymous confession',
				'  feed             - View recent confessions',
				'  clear            - Clear the terminal',
				'  about            - About Cope Terminal',
				'  help             - Show this help message'
			].forEach(l => this.addLine(l));
		}

		showAbout() {
			[
				'Cope Terminal v2.0.0',
				'Anonymous terminal for degen confessions',
				'All data stored locally (offline mode)',
				'Replies sourced from local input.json/output.json with sarcasm enabled'
			].forEach(l => this.addLine(l));
		}

		loadConfessions() {
			try {
				return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
			} catch {
				return [];
			}
		}

		saveConfessions() {
			try {
				localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.confessions.slice(0, 50)));
			} catch (e) {
				console.error('Failed to save to localStorage:', e);
			}
		}

		copeAndDisplay(message) {
			if (!message || !message.trim()) {
				this.addLine('Usage: cope <your confession>', 'error');
				return;
			}

			// NEW: if a previous user reply is still "thinking", finalize it now
			this.flushPendingUserReply();

			const sanitized = this.sanitize(message.trim());
			const confession = {
				id: Date.now().toString(),
				message: sanitized,
				timestamp: new Date().toISOString(),
				displayTime: new Date().toLocaleString(),
				userId: this.userId,
				_isUser: true // mark as user-originated for pending tracking
			};
			this.confessions.unshift(confession);
			this.saveConfessions();
			this.renderConfession(confession);
		}

		// Updated renderConfession scheduling to use scheduler
		renderConfession(confession) {
			const message = typeof confession === 'string' ? confession : confession.message;
			const userId = confession && confession.userId ? confession.userId : this.userId;
			const time = confession && (confession.displayTime || confession.timestamp)
				? (confession.displayTime || new Date(confession.timestamp).toLocaleString())
				: new Date().toLocaleString();

			const wrap = document.createElement('div');
			wrap.className = 'line confession';

			const meta = document.createElement('div');
			meta.className = 'confession-meta';
			meta.textContent = `[${time}] ${userId}`;

			const msg = document.createElement('div');
			msg.textContent = `"${message}"`;

			// per-confession placeholder to keep pairing intact
			const placeholder = document.createElement('div');
			placeholder.className = 'therapist-reply';
			placeholder.textContent = 'System is thinking...';

			wrap.appendChild(meta);
			wrap.appendChild(msg);
			wrap.appendChild(placeholder);
			this.output.appendChild(wrap);
			this.output.scrollTop = this.output.scrollHeight;

			// Schedule reply for this specific confession using scheduler
			const delay = this.getThinkingDelay();
			const taskId = this.scheduler.schedule(() => {
				this.renderTherapistReply(message, wrap, placeholder);
				// clear tracker if this was the tracked pending user reply
				if (this.pendingUserReply && this.pendingUserReply.placeholderNode === placeholder) {
					this.pendingUserReply = null;
				}
			}, delay);

			// NEW: only track user-originated confessions as "pending"
			if (confession && confession._isUser) {
				this.pendingUserReply = {
					taskId,           // scheduler id (not raw timeout)
					container: wrap,
					placeholderNode: placeholder,
					message
				};
			}
		}

		// finalize the last pending user reply immediately (if any)
		privateFlushReply(container, placeholderNode, msg) {
			// renderTherapistReply updates in place when placeholderNode is provided
			this.renderTherapistReply(msg, container, placeholderNode);
		}
		flushPendingUserReply() {
			if (!this.pendingUserReply) return;
			const p = this.pendingUserReply;
			// cancel scheduled task via scheduler
			if (p.taskId && this.scheduler) this.scheduler.clear(p.taskId);
			// render immediately
			this.privateFlushReply(p.container, p.placeholderNode, p.message);
			this.pendingUserReply = null;
		}

		renderTherapistReply(message, container, placeholderNode) {
			let reply = this.responseEngine?.getReply(message);
			if (!reply) reply = "[Response engine unavailable - check if JSON files loaded correctly]";
			const text = `System: ${reply}`;

			if (placeholderNode && placeholderNode.parentNode === container) {
				placeholderNode.textContent = text;
				return;
			}
			if (container) {
				const node = document.createElement('div');
				node.className = 'therapist-reply';
				node.textContent = text;
				container.appendChild(node);
				this.output.scrollTop = this.output.scrollHeight;
				return;
			}
			this.addLine(text, 'therapist-reply');
		}

		startAutoFeed() {
			// Always show the loading message regardless of confession availability
			const nextDelay = () => {
				const skew = Math.random() ** 2;
				return Math.floor(this.MIN_INTERVAL + (this.MAX_INTERVAL - this.MIN_INTERVAL) * skew);
			};

			const randomUserId = () => this.generateRandomUserId();

			const tick = () => {
				// Always show loading message
				this.addLine('Loading latest user submission...');

				// use scheduler to delay the inner loading logic uniformly
				const inner = () => {
					if (!Array.isArray(this.preloadedConfessions) || !this.preloadedConfessions.length) {
						// If no confessions available, show message but continue the cycle
						this.addLine('No preloaded confessions found. Add confessions to input.json.', 'error');
						// schedule next cycle
						this.scheduler.schedule(() => requestAnimationFrame(tick), nextDelay());
						return;
					}

					// Mark that we've shown at least one item
					this._feedItemShown = true;

					// Log which confession we're about to display
					const availableIndices = [];
					for (let i = 0; i < this.preloadedConfessions.length; i++) {
						if (!this.displayedConfessions.has(i)) availableIndices.push(i);
					}
					
					if (availableIndices.length === 0) {
						// Reset when all have been shown
						this.displayedConfessions.clear();
						console.log('All confessions have been shown. Resetting cycle.');
						for (let i = 0; i < this.preloadedConfessions.length; i++) {
							availableIndices.push(i);
						}
					}
					
					const idx = availableIndices[Math.floor(Math.random() * availableIndices.length)];
					this.displayedConfessions.add(idx);
					
					console.log(`Displaying confession #${idx}:`, this.preloadedConfessions[idx].substring(0, 50) + '...');

					const confessionObj = {
						message: this.preloadedConfessions[idx],
						userId: randomUserId(),
						displayTime: new Date().toLocaleString()
					};
					this.renderConfession(confessionObj);

					// schedule next cycle
					this.scheduler.schedule(() => requestAnimationFrame(tick), nextDelay());
				};

				// schedule inner() after LOADING_DELAY using scheduler to be resilient to throttling
				this.scheduler.schedule(inner, this.LOADING_DELAY);
			};

			// Start the cycle now (use requestAnimationFrame once for consistent init)
			requestAnimationFrame(tick);
		}

		// Helper for random user IDs (reused for consistency)
		generateRandomUserId() {
			const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
			let id = '';
			for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
			return `user@${id}`;
		}

		clearTerminal() {
			this.output.innerHTML = '';
			this.addLine('Welcome to Cope Terminal - Anonymous relief for on-chain trauma.');
			this.addLine(`Type 'help' for available commands`);
		}
	}

	function init() {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => new TerminalApp());
		} else {
			new TerminalApp();
		}
	}

	init();
})();