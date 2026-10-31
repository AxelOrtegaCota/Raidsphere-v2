/**
 * Module B: boundary validation for EventSub WebSocket messages.
 * Every field the server reads from Twitch is checked here before it reaches a handler.
 *
 * @see https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
 */
import { z } from 'zod';

const subscriptionSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  status: z.string().min(1),
});

const sessionSchema = z.object({
  id: z.string().min(1),
  keepalive_timeout_seconds: z.number().positive().nullable().optional(),
  reconnect_url: z.string().nullable().optional(),
});

const metadataSchema = z.object({
  message_id: z.string().min(1),
  message_type: z.string().min(1),
});

/** Keepalive payloads are empty objects, so every payload field is optional here. */
export const eventSubEnvelopeSchema = z.object({
  metadata: metadataSchema,
  payload: z.object({
    session: sessionSchema.optional(),
    subscription: subscriptionSchema.optional(),
    event: z.unknown().optional(),
  }),
});

export const subscriptionResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })).min(1),
});

const broadcasterFields = {
  broadcaster_user_id: z.string().min(1),
  broadcaster_user_login: z.string(),
  broadcaster_user_name: z.string(),
};

const targetUserFields = {
  target_user_id: z.string().min(1),
  target_user_login: z.string(),
  target_user_name: z.string(),
};

export const raidEventSchema = z.object({
  from_broadcaster_user_id: z.string().min(1),
  from_broadcaster_user_login: z.string(),
  from_broadcaster_user_name: z.string(),
  to_broadcaster_user_id: z.string().min(1),
  to_broadcaster_user_login: z.string(),
  to_broadcaster_user_name: z.string(),
  viewers: z.number().int().nonnegative(),
});

export const chatMessageEventSchema = z.object({
  ...broadcasterFields,
  chatter_user_id: z.string().min(1),
  chatter_user_login: z.string(),
  chatter_user_name: z.string(),
  message_id: z.string().min(1),
  // Set on shared chat messages, which can come from another channel.
  source_broadcaster_user_id: z.string().nullable().optional(),
  message: z.object({
    text: z.string(),
    fragments: z.array(z.object({
      type: z.string(),
      text: z.string(),
      cheermote: z.object({ prefix: z.string(), bits: z.number() }).nullable().optional(),
      emote: z.object({ id: z.string(), emote_set_id: z.string() }).nullable().optional(),
      mention: z.object({ user_id: z.string(), user_login: z.string(), user_name: z.string() }).nullable().optional(),
    })),
  }),
  color: z.string(),
  badges: z.array(z.object({ set_id: z.string(), id: z.string(), info: z.string() })),
});

export const chatMessageDeleteEventSchema = z.object({
  ...broadcasterFields, ...targetUserFields, message_id: z.string().min(1),
});

export const chatClearEventSchema = z.object(broadcasterFields);

export const chatClearUserEventSchema = z.object({ ...broadcasterFields, ...targetUserFields });

export const notificationSchemas = {
  'channel.raid': raidEventSchema,
  'channel.chat.message': chatMessageEventSchema,
  'channel.chat.message_delete': chatMessageDeleteEventSchema,
  'channel.chat.clear': chatClearEventSchema,
  'channel.chat.clear_user_messages': chatClearUserEventSchema,
} as const;

export type EventSubEnvelope = z.infer<typeof eventSubEnvelopeSchema>;
export type RaidEvent = z.infer<typeof raidEventSchema>;
export type ChannelChatMessageEvent = z.infer<typeof chatMessageEventSchema>;
export type ChatMessageDeleteEvent = z.infer<typeof chatMessageDeleteEventSchema>;
export type ChatClearEvent = z.infer<typeof chatClearEventSchema>;
export type ChatClearUserEvent = z.infer<typeof chatClearUserEventSchema>;
