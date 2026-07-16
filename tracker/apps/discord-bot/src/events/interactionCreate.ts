import {
  Events,
  InteractionType,
  type Interaction,
} from 'discord.js';
import { commands, buttonHandlers } from '../commands/index.js';
import logger, { toLogError } from '../logger.js';

export function registerInteractionCreate(
  client: import('discord.js').Client,
): void {
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    handleInteraction(interaction).catch((err: unknown) => {
      logger.error(
        { interactionId: interaction.id, err: toLogError(err) },
        'Unhandled error in interactionCreate',
      );
    });
  });
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.type === InteractionType.ApplicationCommand) {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) {
      logger.warn({ commandName: interaction.commandName }, 'Unknown command');
      await interaction.reply({
        content: '❌ Commande inconnue.',
        ephemeral: true,
      });
      return;
    }

    logger.info(
      { commandName: interaction.commandName, userId: interaction.user.id },
      'Slash command received',
    );

    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error(
        { commandName: interaction.commandName, err: toLogError(err) },
        'Command execution error',
      );
      const payload = {
        content: '❌ Une erreur inattendue est survenue. Réessayez plus tard.',
        ephemeral: true,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    }
    return;
  }

  if (interaction.isButton()) {
    const parts = interaction.customId.split('|');
    const prefix = parts[0];

    const handler = buttonHandlers.find((h) => h.prefix === prefix);
    if (!handler) {
      logger.warn({ customId: interaction.customId }, 'Unknown button prefix');
      await interaction.deferUpdate();
      return;
    }

    logger.info(
      { customId: interaction.customId, userId: interaction.user.id },
      'Button interaction received',
    );

    try {
      await handler.handle(interaction, parts);
    } catch (err) {
      logger.error(
        { customId: interaction.customId, err: toLogError(err) },
        'Button handler error',
      );
      await interaction.editReply({
        content: '❌ Une erreur est survenue lors de la navigation.',
        components: [],
      });
    }
  }
}
