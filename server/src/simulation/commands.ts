import type { LanguageCode } from '@raidsphere/shared';
import type { ChatCommand, CommandRole } from '../application/ports.js';

// In-process chat command simulator for tests and the local demo (D2-05 rule 5, D2-13 rule 7).
// It is not a network endpoint and grants no remote control capability.

export interface CommandTarget {
  handleCommand(command: ChatCommand): Promise<void>;
}

export interface SimulatedUser {
  userId: string;
  role: CommandRole;
}

export class CommandSimulator {
  readonly #target: CommandTarget;
  readonly #channelId: string;
  #nextMessage = 0;

  constructor(target: CommandTarget, channelId: string) {
    this.#target = target;
    this.#channelId = channelId;
  }

  // The broadcaster is the user whose ID equals the channel ID.
  get broadcaster(): SimulatedUser {
    return { userId: this.#channelId, role: 'broadcaster' };
  }

  roulette(user: SimulatedUser = this.broadcaster): Promise<void> {
    return this.#send(user, { type: 'roulette' });
  }

  cancel(user: SimulatedUser = this.broadcaster): Promise<void> {
    return this.#send(user, { type: 'cancel' });
  }

  vote(userId: string, language: LanguageCode): Promise<void> {
    return this.#send({ userId, role: 'viewer' }, { type: 'vote', language });
  }

  #send(user: SimulatedUser, command: ChatCommand['command']): Promise<void> {
    this.#nextMessage += 1;
    return this.#target.handleCommand({
      messageId: `sim-message-${this.#nextMessage}`, channelId: this.#channelId, userId: user.userId, role: user.role, command,
    });
  }
}
