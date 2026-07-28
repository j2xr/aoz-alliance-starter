// Centralized user-facing Discord strings. Errors get a generic, actionable
// message here; the raw detail (exception message, stack, etc.) must only
// ever go to `logger.error`, never back to a Discord channel — see B4 in the
// master plan.

export const messages = {
  screenUnrecognized: (filename: string, detail: string): string =>
    `⚠️ **${filename}** — unrecognized screen type: \`${detail}\`. Use \`/upload event_type:<type>\` or \`/upload kind:donation\`.`,

  ocrError: (filename: string, error: string, detail: string | undefined): string =>
    `⚠️ **${filename}** — OCR: ${error}${detail ? ` (${detail})` : ''}`,

  databaseError: (filename: string): string =>
    `❌ **${filename}** — database error. Details in the logs.`,

  unexpectedError: (filename: string): string =>
    `❌ **${filename}** — unexpected error. Details in the logs.`,

  unknownEventType: (filename: string, eventType: string): string =>
    `⚠️ **${filename}** — unknown event type: \`${eventType}\`. Use \`/upload event_type:<type>\`.`,

  missingDatetime: (filename: string): string =>
    `⚠️ **${filename}** — the event date/time is unreadable on the screenshot. Re-crop the screen (header visible) and resend it.`,

  duplicate: (filename: string): string => `🔁 **${filename}** — screenshot already processed (duplicate).`,

  unsupportedPeriodType: (filename: string, periodType: string): string =>
    `⚠️ **${filename}** — tab \`${periodType}\` is not handled (V1 = Weekly only).`,

  // Distinct from unsupportedPeriodType: 'unknown' means the tab band
  // (Daily/Weekly/History) couldn't be read at all, not that a real,
  // recognized tab (Daily/History) was rejected. Telling the user which
  // failure mode they hit points them at a different fix (re-crop vs.
  // switch to the Weekly tab in-game).
  unreadableDonationTab: (filename: string): string =>
    `⚠️ **${filename}** — the tab (Daily/Weekly/History) is unreadable on this screenshot. ` +
    'Check that the tab strip is visible and well framed, then resend the screenshot.',

  noDonationMembers: (filename: string): string =>
    `⚠️ **${filename}** — no members extracted from the donation screenshot.`,

  allianceResolutionError: (): string =>
    '⚠️ Error while resolving the alliance. Please try again later.',

  allianceAlreadyLinked: (allianceName: string): string =>
    `⚠️ This channel is already linked to alliance **${allianceName}**.`,

  allianceNameTaken: (name: string): string =>
    `⚠️ An alliance named **${name}** already exists (linked to another channel). Choose a different name.`,

  possibleTruncation: (filename: string): string =>
    `⚠️ **${filename}** — reading stopped before the list possibly ended ` +
    '(several unreadable lines in a row). Some players may be missing: ' +
    'check the full ranking.',

  // Distinct from possibleTruncation above: that one is advisory (a warning
  // next to an otherwise-successful embed); this one is a hard rejection —
  // too little of the capture was read to trust as real data (e.g. 1 of 12
  // visible members), so nothing was written to the database at all.
  possibleTruncationRejected: (filename: string, memberCount: number, expectedRows: number): string =>
    `❌ **${filename}** — reading too incomplete (${memberCount}/${expectedRows} lines read): ` +
    'screenshot rejected, nothing recorded. Re-crop the screenshot (full list visible) and resend it.',

  correctionReverted: (filename: string, count: number): string =>
    `⚠️ **${filename}** — ${count} manual correction${count > 1 ? 's' : ''} ` +
    `(\`/correct\`) overwritten by this screenshot. History kept in ` +
    '`at_corrections`.',

  allianceCreated: (name: string): string =>
    `Alliance **${name}** created and linked to this channel.\n\n` +
    `⚠️ For the bot to process screenshots posted here, add this ` +
    `channel's ID to the \`DISCORD_ALLOWED_CHANNEL_IDS\` environment variable, ` +
    `then restart the bot.\n\n` +
    `To give a member access to the \`/tracking\` dashboard, follow step ` +
    `"First login & link yourself to an alliance" in \`docs/SETUP.md\`.`,
} as const;
