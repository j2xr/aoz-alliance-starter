// Discord hard-caps message `content` at 2000 chars; an edit/reply over that
// throws DiscordAPIError[50035] (Invalid Form Body) outside any try/catch at
// the call sites below, discarding the whole reply — embeds included, even
// when they were built successfully. A real batch of donation/correction
// warnings can exceed this: one truncation warning alone is ~215 chars, so
// as few as ~10 attachments in a single upload push past the limit.
// reprocess-channel.ts already guards its own summary this way
// (`.slice(0, 1900)`); this factors the same margin out for the other two
// call sites that build a `lines.join('\n')` content string.
const DISCORD_CONTENT_MAX = 1900;

export function capDiscordContent(content: string, maxLen = DISCORD_CONTENT_MAX): string {
  return content.slice(0, maxLen);
}
