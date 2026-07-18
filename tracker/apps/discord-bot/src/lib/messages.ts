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

  allianceResolutionError: (): string =>
    "⚠️ Erreur lors de la résolution de l'alliance. Veuillez réessayer plus tard.",

  allianceAlreadyLinked: (allianceName: string): string =>
    `⚠️ Ce channel est déjà associé à l'alliance **${allianceName}**.`,

  allianceNameTaken: (name: string): string =>
    `⚠️ Une alliance nommée **${name}** existe déjà (liée à un autre channel). Choisissez un autre nom.`,

  allianceCreated: (name: string): string =>
    `Alliance **${name}** créée et liée à ce channel.\n\n` +
    `⚠️ Pour que le bot traite les captures postées ici, ajoutez l'ID de ce ` +
    `channel à la variable d'environnement \`DISCORD_ALLOWED_CHANNEL_IDS\` puis ` +
    `redémarrez le bot.\n\n` +
    `Pour donner accès au dashboard \`/tracking\` à un membre, suivez l'étape ` +
    `« Lier un compte à l'alliance » de \`docs/SETUP.md\`.`,
} as const;
