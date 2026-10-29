/**
 * Module B: in-process simulated chat for the local demo and tests.
 * Messages go through the real command parser and adapter, as EventSub chat will.
 * It is not a network endpoint and grants no remote control capability.
 */
import type { ChatCommand } from '../application/ports.js';
import { toChatCommand } from './adapters.js';
import type { ChatMessage } from './commands.js';

export interface ChatCommandTarget {
  handleCommand(command: ChatCommand): Promise<void>;
}

export interface SimulatedChatter {
  userId: string;
  isBroadcaster?: boolean;
  isModerator?: boolean;
}

export class SimulatedChat {
  private readonly target: ChatCommandTarget;
  private readonly channelId: string;
  private nextMessage = 0;

  constructor(target: ChatCommandTarget, channelId: string) {
    this.target = target;
    this.channelId = channelId;
  }

  /** The broadcaster is the user whose ID equals the channel ID. */
  get broadcaster(): SimulatedChatter {
    return { userId: this.channelId, isBroadcaster: true };
  }

  /** Returns false when the text is not a valid command, so nothing is dispatched. */
  async say(chatter: SimulatedChatter, text: string): Promise<boolean> {
    this.nextMessage += 1;
    const message: ChatMessage = {
      messageId: `sim-chat-${this.nextMessage}`, userId: chatter.userId, userLogin: chatter.userId,
      channelId: this.channelId, text, timestamp: Date.now(),
      ...(chatter.isBroadcaster === undefined ? {} : { isBroadcaster: chatter.isBroadcaster }),
      ...(chatter.isModerator === undefined ? {} : { isModerator: chatter.isModerator }),
    };
    const command = toChatCommand(message);
    if (!command) return false;
    await this.target.handleCommand(command);
    return true;
  }
}
