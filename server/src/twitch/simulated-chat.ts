/**
 * Module B: in-process simulated chat for the local demo and tests.
 * Messages go through the real command parser and adapter, as EventSub chat will.
 * It is not a network endpoint and grants no remote control capability.
 */
import type { LanguageCode } from '@raidsphere/shared';
import type { ChatCommand, ChatTextMessage } from '../application/ports.js';
import { toChatCommand, toChatTextMessage } from './adapters.js';
import type { ChatMessage } from './commands.js';

export interface ChatCommandTarget {
  handleCommand(command: ChatCommand): Promise<void>;
}

export interface ChatMessageTarget {
  handleMessage(message: ChatTextMessage): Promise<void>;
}

export interface SimulatedChatter {
  userId: string;
  isBroadcaster?: boolean;
  isModerator?: boolean;
  // Language detection is not built yet, so a simulated chatter states it.
  language?: LanguageCode;
}

export class SimulatedChat {
  private readonly target: ChatCommandTarget;
  private readonly channelId: string;
  private readonly messages: ChatMessageTarget | undefined;
  private nextMessage = 0;

  constructor(target: ChatCommandTarget, channelId: string, messages?: ChatMessageTarget) {
    this.target = target;
    this.channelId = channelId;
    this.messages = messages;
  }

  /** The broadcaster is the user whose ID equals the channel ID. */
  get broadcaster(): SimulatedChatter {
    return { userId: this.channelId, isBroadcaster: true };
  }

  /** Returns false when nothing was dispatched: an invalid command, or plain text with no message target. */
  async say(chatter: SimulatedChatter, text: string): Promise<boolean> {
    this.nextMessage += 1;
    const message: ChatMessage = {
      messageId: `sim-chat-${this.nextMessage}`, userId: chatter.userId, userLogin: chatter.userId,
      channelId: this.channelId, text, timestamp: Date.now(),
      ...(chatter.isBroadcaster === undefined ? {} : { isBroadcaster: chatter.isBroadcaster }),
      ...(chatter.isModerator === undefined ? {} : { isModerator: chatter.isModerator }),
    };
    const command = toChatCommand(message);
    if (command) {
      await this.target.handleCommand(command);
      return true;
    }
    if (!this.messages || text.trimStart().startsWith('!')) return false;
    await this.messages.handleMessage(toChatTextMessage(message, {
      displayName: chatter.userId, sourceLanguage: chatter.language ?? null,
    }));
    return true;
  }
}
