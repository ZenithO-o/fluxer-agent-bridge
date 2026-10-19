// Pi extension. Pi is the local agent. A ping, reply, or DM starts a turn.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WAKE = new Set(["ping", "reply-to-bot", "dm"]);

function inboxPath(): string {
	return process.env.FLUXER_INBOX || path.join(os.homedir(), ".local/state/fluxer-agent-bridge/inbox.jsonl");
}

function lineOf(message: Record<string, unknown>): string {
	const author = (message.author as { display_name?: string; username?: string } | undefined) || {};
	const who = author.display_name || author.username || "someone";
	const where = message.channel_name || message.channel_id || "unknown";
	// guild is what writes must pass (guild_id, or dm=true); the fluxer tools refuse any other server.
	const guild = message.guild_id || (message.is_dm ? "dm" : "unknown");
	return `${who} in #${where} (${message.reason}) message ${message.id} channel ${message.channel_id} guild ${guild}: ${message.content ?? ""}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let offset = 0;
	let buf = "";
	const seen = new Set<string>();

	function stop() {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	function deliver(text: string, ctx: { isIdle: () => boolean; ui: { notify: (text: string, level: "error") => void } }) {
		const options = ctx.isIdle() ? undefined : { deliverAs: "followUp" as const };
		try {
			pi.sendUserMessage(text, options);
		} catch {
			try {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			} catch (err) {
				ctx.ui.notify(`fluxer wake failed: ${err}`, "error");
			}
		}
	}

	function take(line: string, ctx: { isIdle?: () => boolean; ui?: { notify: (text: string, level: string) => void } }) {
		let row: { batch?: { test?: boolean; bot?: string; messages?: Record<string, unknown>[] } };
		try {
			row = JSON.parse(line);
		} catch {
			return;
		}
		const batch = row.batch || {};
		if (batch.test) return;
		const fresh = (batch.messages || []).filter((message) => {
			const id = String(message.id || "");
			return WAKE.has(String(message.reason)) && id && !seen.has(id) && seen.add(id);
		});
		if (!fresh.length) return;
		deliver(fresh.map(lineOf).join("\n") + `\nbot ${batch.bot || "unknown"}`, ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		stop();
		const file = inboxPath();
		offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
		buf = "";
		timer = setInterval(() => {
			try {
				if (!fs.existsSync(file)) return;
				const size = fs.statSync(file).size;
				if (size < offset) offset = 0;
				if (size === offset) return;
				const fd = fs.openSync(file, "r");
				const data = Buffer.alloc(size - offset);
				fs.readSync(fd, data, 0, data.length, offset);
				fs.closeSync(fd);
				offset = size;
				buf += data.toString("utf8");
				let nl = buf.indexOf("\n");
				while (nl >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (line.trim()) take(line, ctx);
					nl = buf.indexOf("\n");
				}
			} catch (err) {
				ctx.ui.notify(`fluxer wake read failed: ${err}`, "error");
			}
		}, 1000);
	});

	pi.on("session_shutdown", async () => {
		stop();
	});
}
