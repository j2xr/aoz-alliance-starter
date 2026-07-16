import { Collection } from 'discord.js';
import type { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import type {
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandOptionsOnlyBuilder,
} from 'discord.js';

import * as event from './event.js';
import * as player from './player.js';
import * as playerAlias from './player-alias.js';
import * as leaderboard from './leaderboard.js';
import * as upload from './upload.js';
import * as reprocess from './reprocess.js';
import * as reprocessChannel from './reprocess-channel.js';
import * as membership from './membership.js';
import * as donation from './donation.js';
import * as merge from './merge.js';

export type Command = {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
};

export type ButtonHandler = {
  prefix: string;
  handle: (interaction: ButtonInteraction, parts: string[]) => Promise<void>;
};

export const commands = new Collection<string, Command>([
  ['event', event],
  ['player', player],
  ['player-alias', playerAlias],
  ['leaderboard', leaderboard],
  ['upload', upload],
  ['reprocess', reprocess],
  ['reprocess-channel', reprocessChannel],
  ['membership', membership],
  ['donation', donation],
  ['merge', merge],
]);

// Button handlers keyed by customId prefix (first segment before |)
export const buttonHandlers: ButtonHandler[] = [
  { prefix: 'el', handle: event.handleButton },
  { prefix: 'lb', handle: leaderboard.handleButton },
  { prefix: 'dlb', handle: donation.handleButton },
];
