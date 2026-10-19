// Pi extension. Pi is the local agent. A ping, reply, or DM starts a turn.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---- render: untrusted text is wrapped and newline-free (kept plain JS so image/test can run it) ----
// Header line: bridge-derived routing only (reason, ids). Everything a Fluxer user wrote goes inside «fluxer:u»…«/fluxer:u»
// with « and » doubled, and CR/LF/U+2028/U+2029 shown as ⏎, so no content can start a line that looks like a wake.
const WAKE = new Set(["ping", "reply-to-bot", "dm"]);
const OPEN = "\u00abfluxer:u\u00bb";
const CLOSE = "\u00ab/fluxer:u\u00bb";

const escapeUntrusted = (s) => String(s).replaceAll("\u00ab", "\u00ab\u00ab").replaceAll("\u00bb", "\u00bb\u00bb");
const neutralizeNewlines = (s) => String(s).replace(/[\r\n\u2028\u2029\u0085\v\f]/g, "\u23ce");
const truncate = (s, n) => (s.length <= n ? s : s.slice(0, n) + `\u2026[truncated ${s.length} chars]`);
const isWrapped = (s) => typeof s === "string" && s.length >= OPEN.length + CLOSE.length && s.startsWith(OPEN) && s.endsWith(CLOSE);
const unwrap = (s) => s.slice(OPEN.length, s.length - CLOSE.length).replaceAll("\u00ab\u00ab", "\u00ab").replaceAll("\u00bb\u00bb", "\u00bb");
/** Wrap one untrusted value. A value the bridge already wrapped (batch.trust.wrapped) is unwrapped and re-wrapped, never trusted as-is. */
function slot(value, n, bridgeWrapped) {
	let raw = String(value ?? "");
	if (bridgeWrapped && isWrapped(raw)) raw = unwrap(raw);
	return OPEN + escapeUntrusted(neutralizeNewlines(truncate(raw, n))) + CLOSE;
}
const bareId = (v) => (/^[0-9]{1,25}$/.test(String(v ?? "")) ? String(v) : "?");
const bareWord = (v) => (/^[a-z0-9_-]{1,32}$/i.test(String(v ?? "")) ? String(v) : "?");

function lineOf(message, bridgeWrapped = false) {
	const author = (message && typeof message.author === "object" && message.author) || {};
	const who = slot(author.display_name || author.username || "someone", 64, bridgeWrapped);
	const where = slot(message.channel_name || message.channel_id || "unknown", 128, bridgeWrapped);
	const content = slot(message.content ?? "", 2000, bridgeWrapped);
	// guild: pass as guild_id (or dm=true) to assert a reply stays in this server; optional.
	const guild = message.guild_id ? bareId(message.guild_id) : message.is_dm ? "dm" : "unknown";
	const header = `fluxer-event reason=${bareWord(message.reason)} message_id=${bareId(message.id)} channel_id=${bareId(message.channel_id)} guild=${guild}`;
	const files = Array.isArray(message.attachments)
		? message.attachments.filter((a) => a && a.filename).map((a) => slot(a.filename, 128, bridgeWrapped))
		: [];
	return `${header}\nwho=${who}\nwhere=#${where}\ncontent=${content}${files.length ? `\nattachments=${files.join(" ")}` : ""}`;
}

/** The text a wake delivers for one inbox batch, or null when nothing in it should start a turn. */
function render(batch, seen) {
	if (!batch || typeof batch !== "object" || Array.isArray(batch) || batch.test) return null;
	const list = Array.isArray(batch.messages) ? batch.messages : [];
	const fresh = list.filter((message) => {
		if (!message || typeof message !== "object") return false;
		const id = String(message.id || "");
		return WAKE.has(String(message.reason)) && id && !seen.has(id) && seen.add(id);
	});
	if (!fresh.length) return null;
	const wrapped = !!(batch.trust && batch.trust.wrapped === true);
	return fresh.map((m) => lineOf(m, wrapped)).join("\n\n") + `\nbot ${bareWord(batch.bot)}`;
}
// ---- end render ----

function inboxPath(): string {
	return process.env.FLUXER_INBOX || path.join(os.homedir(), ".local/state/fluxer-agent-bridge/inbox.jsonl");
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
		let row: any;
		try {
			row = JSON.parse(line);
		} catch {
			return;
		}
		if (!row || typeof row !== "object") return;
		const text = render(row.batch, seen);
		if (text) deliver(text, ctx as any);
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
