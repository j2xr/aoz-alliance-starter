import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import logger from './logger.js';
import { handleMessageCreate } from './events/messageCreate.js';
import { registerInteractionCreate } from './events/interactionCreate.js';
import { deployCommands } from './lib/deploy-commands.js';
import { startHealthServer } from './health.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // privileged intent — must be enabled in the Discord developer portal
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  logger.info(
    { username: c.user.tag, allowedChannels: [...config.allowedChannelIds] },
    'Discord bot ready',
  );

  deployCommands(c.application.id).catch((err: unknown) => {
    logger.error({ err: String(err) }, 'Failed to register slash commands');
  });
});

client.on(Events.MessageCreate, (message) => {
  handleMessageCreate(message).catch((err: unknown) => {
    logger.error(
      { messageId: message.id, err: String(err) },
      'Unhandled error in messageCreate',
    );
  });
});

registerInteractionCreate(client);

client.login(config.discordToken).catch((err: unknown) => {
  logger.error({ err: String(err) }, 'Failed to login to Discord');
  process.exit(1);
});

startHealthServer(client);
