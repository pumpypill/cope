(function () {
	'use strict';

	// New: ResponseEngine for selecting sarcastic replies from input/output JSON
	class ResponseEngine {
		constructor() {
			this.ready = false;
			this.prompts = [];
			this.outputs = [];
			this.map = new Map(); // prompt -> responses[]
			this.used = new Map(); // prompt -> Set(usedIndices)
			this.allResponses = [];
			this.genericFallback = [
				"Strong conviction, weak risk. Classic.",
				"You didn’t trade; you cosplayed a trader.",
				"Touch grass, not buttons.",
				"Hope isn’t a strategy; exits are.",
				"You earned that drawdown the hard way."
			];
		}

		async init() {
			try {
				const [prompts, outputs] = await Promise.all([
					fetch('./input.json').then(r => r.json()),
					fetch('./output.json').then(r => r.json())
				]);
				this.prompts = Array.isArray(prompts) ? prompts : [];
				this.outputs = Array.isArray(outputs) ? outputs : [];
				this.outputs.forEach(o => this.map.set(o.prompt, o.responses || []));
				this.allResponses = this.outputs.flatMap(o => o.responses || []);
				this.ready = true;
			} catch (e) {
				console.warn('ResponseEngine: failed to load input/output JSON. Using fallback.', e);
				this.ready = true;
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
			if (!this.ready) return null;
			const best = this.findBestPrompt(message);
			if (best) {
				const reply = this.pickFromPrompt(best);
				if (reply) return reply;
			}
			if (this.allResponses.length) {
				return this.allResponses[Math.floor(Math.random() * this.allResponses.length)];
			}
			return this.genericFallback[Math.floor(Math.random() * this.genericFallback.length)];
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

			// Preloaded feed
			this.preloadedConfessions = this.loadPreloadedConfessions();
			this.displayedConfessions = new Set();

			// Timing
			this.STARTUP_FEED_DELAY = 5000;
			this.MIN_INTERVAL = 15000;
			this.MAX_INTERVAL = 45000;
			this.LOADING_DELAY = 2000;

			// New: response engine
			this.responseEngine = new ResponseEngine();
			this.responseEngine.init();

			// Commands
			this.commands = {
				help: () => this.showHelp(),
				confess: (msg) => this.confessAndDisplay(msg),
				feed: () => this.showFeed(),
				clear: () => this.clearTerminal(),
				about: () => this.showAbout()
			};

			this.initEvents();
			this.clearTerminal();
			setTimeout(() => this.startAutoFeed(), this.STARTUP_FEED_DELAY);
		}

		// Load preloaded confessions from the pumpfessions.md content
		loadPreloadedConfessions() {
			// Array of preloaded confessions extracted from pumpfessions.md
			return [
				"Sold my wife's wedding ring for TROLL. She found out when I couldn't afford this month's rent. Moving out tomorrow.",
				"$500 → $12k → $89 → food stamps. Thanks Cupsey.",
				"Day 47: Still can't tell my parents I lost their retirement fund on Unstable coin. Dad keeps asking about the \"crypto gains.\"",
				"Watched BAGWORK pump 400% while my sell order sat 0.01% too high. Pain.",
				"/status update: living in car. portfolio up 140%. worth it. $RETIRE to the moon.",
				"Just took out a 28k personal loan to average down on CHILLHOUSE. This can't go wrong, right?",
			];
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
				'  confess <message> - Post an anonymous confession',
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

		confessAndDisplay(message) {
			if (!message || !message.trim()) {
				this.addLine('Usage: confess <your confession>', 'error');
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
			this.addLine('Confession stored locally (offline mode)', 'success');
		}

		sanitize(input) {
			return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}

		showFeed() {
			if (!this.confessions.length) {
				this.addLine('No confessions found. Be the first to confess!');
				return;
			}
			this.addLine('=== Local Pumpfessions ===');
			this.confessions.slice(0, 10).forEach(c => this.renderConfession(c));
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

			this.renderTherapistReply(message);
		}

		renderTherapistReply(message) {
			// Use ResponseEngine if ready; otherwise fallback to legacy list
			const fallback = [
				'Therapist: breathe, learn, adjust size, live to trade another day.',
				'Therapist: note the pattern, set rules you will actually follow.',
				'Therapist: wins don’t define you, losses don’t destroy you.',
				'Therapist: step away, hydrate, reset—charts will still be there.',
				'Therapist: journal this, extract the lesson, move forward.'
			];
			let reply = this.responseEngine?.getReply(message);
			if (!reply) reply = fallback[Math.floor(Math.random() * fallback.length)];
			// Prefix to keep tone consistent
			this.addLine(`Cope: ${reply}`, 'therapist-reply');
		}

		startAutoFeed() {
			if (!Array.isArray(this.preloadedConfessions) || !this.preloadedConfessions.length) {
				this.addLine('Auto-feed disabled (no preloaded confessions).');
				return;
			}

			const nextDelay = () => {
				const skew = Math.random() ** 2;
				return Math.floor(this.MIN_INTERVAL + (this.MAX_INTERVAL - this.MIN_INTERVAL) * skew);
			};

			const randomUserId = () => {
				const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
				let id = '';
				for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
				return `user@${id}`;
			};

			const schedule = (delay) => {
				setTimeout(() => requestAnimationFrame(tick), delay);
			};

			const tick = () => {
				this.addLine('Loading latest user submission...');
				setTimeout(() => {
					// pick an undisplayed confession
					const indices = [];
					for (let i = 0; i < this.preloadedConfessions.length; i++) {
						if (!this.displayedConfessions.has(i)) indices.push(i);
					}
					if (!indices.length) {
						// restart rotation
						this.displayedConfessions.clear();
						for (let i = 0; i < Math.min(3, this.preloadedConfessions.length); i++) {
							// show a few again sparsely over time
							break;
						}
					}
					const pool = indices.length ? indices : [0];
					const idx = pool[Math.floor(Math.random() * pool.length)];
					this.displayedConfessions.add(idx);

					const confessionObj = {
						message: this.preloadedConfessions[idx],
						userId: randomUserId(),
						displayTime: new Date().toLocaleString()
					};
					this.renderConfession(confessionObj);
					schedule(nextDelay());
				}, this.LOADING_DELAY);
			};

			schedule(nextDelay());
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