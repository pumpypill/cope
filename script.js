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

		getReply(message) {
			if (!this.ready) return "[JSON files not loaded - check console]";
			const best = this.findBestPrompt(message);
			if (best) {
				const reply = this.pickFromPrompt(best);
				if (reply) return reply;
			}
			if (this.allResponses.length) {
				return this.allResponses[Math.floor(Math.random() * this.allResponses.length)];
			}
			return "[No matching response found - JSON may be empty]";
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
			const sanitized = this.sanitize(message.trim());
			const confession = {
				id: Date.now().toString(),
				message: sanitized,
				timestamp: new Date().toISOString(),
				displayTime: new Date().toLocaleString(),
				userId: this.userId
			};
			this.confessions.unshift(confession);
			this.saveConfessions();
			this.renderConfession(confession);
			// removed success acknowledgement per UX request
		}

		sanitize(input) {
			return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}

		showFeed() {
			if (!this.confessions.length) {
				this.addLine('No confessions found. Be the first to cope!');
				return;
			}
			this.addLine('=== Local Pumpfessions ===');
			this.confessions.slice(0, 10).forEach(c => this.renderConfession(c));
		}

		getThinkingDelay() {
			return Math.floor(
				this.THINKING_DELAY_MIN +
				Math.random() * (this.THINKING_DELAY_MAX - this.THINKING_DELAY_MIN)
			);
		}

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

			wrap.appendChild(meta);
			wrap.appendChild(msg);
			this.output.appendChild(wrap);
			this.output.scrollTop = this.output.scrollHeight;

			// Show a "thinking" placeholder, then render the reply after a short delay
			const placeholder = this.addLine('System is thinking...', 'therapist-reply');
			setTimeout(() => {
				if (placeholder && placeholder.parentNode) {
					placeholder.parentNode.removeChild(placeholder);
				}
				this.renderTherapistReply(message);
			}, this.getThinkingDelay());
		}

		renderTherapistReply(message) {
			// Use ResponseEngine if ready; otherwise show error message
			let reply = this.responseEngine?.getReply(message);
			if (!reply) reply = "[Response engine unavailable - check if JSON files loaded correctly]";
			// Prefix to keep tone consistent
			this.addLine(`System: ${reply}`, 'therapist-reply');
		}

		startAutoFeed() {
			// Always show the loading message regardless of confession availability
			const nextDelay = () => {
				const skew = Math.random() ** 2;
				return Math.floor(this.MIN_INTERVAL + (this.MAX_INTERVAL - this.MIN_INTERVAL) * skew);
			};

			const randomUserId = () => this.generateRandomUserId();

			const schedule = (delay) => {
				setTimeout(() => requestAnimationFrame(tick), delay);
			};

			const tick = () => {
				// Always show loading message
				this.addLine('Loading latest user submission...');

				setTimeout(() => {
					if (!Array.isArray(this.preloadedConfessions) || !this.preloadedConfessions.length) {
						// If no confessions available, show message but continue the cycle
						this.addLine('No preloaded confessions found. Add confessions to input.json.', 'error');
						return schedule(nextDelay());
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
					schedule(nextDelay());
				}, this.LOADING_DELAY);
			};

			// Start the cycle
			schedule(nextDelay());
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