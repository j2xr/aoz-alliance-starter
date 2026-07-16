import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { commands } from '../commands/index.js';
import logger from '../logger.js';

export async function deployCommands(applicationId: string): Promise<void> {
  const rest = new REST().setToken(config.discordToken);
  const body = [...commands.values()].map((cmd) => cmd.data.toJSON());

  logger.info({ count: body.length }, 'Registering slash commands globally');
  await rest.put(Routes.applicationCommands(applicationId), { body });
  logger.info({ count: body.length }, 'Slash commands registered');
}
