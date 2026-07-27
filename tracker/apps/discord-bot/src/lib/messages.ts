// Centralized user-facing Discord strings (FR — the bot already speaks
// mostly FR). Errors get a generic, actionable message here; the raw detail
// (exception message, stack, etc.) must only ever go to `logger.error`, never
// back to a Discord channel — see B4 in the master plan.

export const messages = {
  screenUnrecognized: (filename: string, detail: string): string =>
    `⚠️ **${filename}** — type d'écran non reconnu : \`${detail}\`. Utilisez \`/upload event:<type>\` ou \`/upload kind:donation\`.`,

  ocrError: (filename: string, error: string, detail: string | undefined): string =>
    `⚠️ **${filename}** — OCR : ${error}${detail ? ` (${detail})` : ''}`,

  databaseError: (filename: string): string =>
    `❌ **${filename}** — erreur base de données. Détail dans les logs.`,

  unexpectedError: (filename: string): string =>
    `❌ **${filename}** — erreur inattendue. Détail dans les logs.`,

  unknownEventType: (filename: string, eventType: string): string =>
    `⚠️ **${filename}** — type d'événement inconnu : \`${eventType}\`. Utilisez \`/upload event:<type>\`.`,

  missingDatetime: (filename: string): string =>
    `⚠️ **${filename}** — date/heure de l'événement illisible sur la capture. Recadrez l'écran (en-tête visible) et renvoyez-la.`,

  duplicate: (filename: string): string => `🔁 **${filename}** — capture déjà traitée (doublon).`,

  unsupportedPeriodType: (filename: string, periodType: string): string =>
    `⚠️ **${filename}** — onglet \`${periodType}\` non géré (V1 = Weekly uniquement).`,

  // Distinct from unsupportedPeriodType: 'unknown' means the tab band
  // (Daily/Weekly/History) couldn't be read at all, not that a real,
  // recognized tab (Daily/History) was rejected. Telling the user which
  // failure mode they hit points them at a different fix (re-crop vs.
  // switch to the Weekly tab in-game).
  unreadableDonationTab: (filename: string): string =>
    `⚠️ **${filename}** — onglet (Daily/Weekly/History) illisible sur cette capture. ` +
    "Vérifiez que la bande d'onglets est visible et bien cadrée, puis renvoyez la capture.",

  noDonationMembers: (filename: string): string =>
    `⚠️ **${filename}** — aucun membre extrait de la capture de dons.`,

  allianceResolutionError: (): string =>
    "⚠️ Erreur lors de la résolution de l'alliance. Veuillez réessayer plus tard.",

  allianceAlreadyLinked: (allianceName: string): string =>
    `⚠️ Ce channel est déjà associé à l'alliance **${allianceName}**.`,

  allianceNameTaken: (name: string): string =>
    `⚠️ Une alliance nommée **${name}** existe déjà (liée à un autre channel). Choisissez un autre nom.`,

  possibleTruncation: (filename: string): string =>
    `⚠️ **${filename}** — lecture interrompue avant la fin possible de la liste ` +
    '(plusieurs lignes illisibles à la suite). Des joueurs pourraient manquer : ' +
    'vérifiez le classement complet.',

  // Distinct from possibleTruncation above: that one is advisory (a warning
  // next to an otherwise-successful embed); this one is a hard rejection —
  // too little of the capture was read to trust as real data (e.g. 1 of 12
  // visible members), so nothing was written to the database at all.
  possibleTruncationRejected: (filename: string, memberCount: number, expectedRows: number): string =>
    `❌ **${filename}** — lecture trop incomplète (${memberCount}/${expectedRows} lignes lues) : ` +
    'capture rejetée, rien enregistré. Recadrez la capture (liste complète visible) et renvoyez-la.',

  correctionReverted: (filename: string, count: number): string =>
    `⚠️ **${filename}** — ${count} correction${count > 1 ? 's' : ''} manuelle${count > 1 ? 's' : ''} ` +
    `(\`/correct\`) écrasée${count > 1 ? 's' : ''} par cette capture. Historique conservé dans ` +
    '`at_corrections`.',

  allianceCreated: (name: string): string =>
    `Alliance **${name}** créée et liée à ce channel.\n\n` +
    `⚠️ Pour que le bot traite les captures postées ici, ajoutez l'ID de ce ` +
    `channel à la variable d'environnement \`DISCORD_ALLOWED_CHANNEL_IDS\` puis ` +
    `redémarrez le bot.\n\n` +
    `Pour donner accès au dashboard \`/tracking\` à un membre, suivez l'étape ` +
    `« Lier un compte à l'alliance » de \`docs/SETUP.md\`.`,
} as const;
