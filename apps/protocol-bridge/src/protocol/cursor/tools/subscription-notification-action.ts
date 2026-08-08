import { create } from "@bufbuild/protobuf"

import {
  type ConversationAction,
  type UserMessageAction,
  UserMessageActionSchema,
} from "../../../gen/agent/v1_pb"

/**
 * Cursor 3.15 handles subscription notifications through the ordinary user
 * message pipeline: the last notification is the current message and every
 * preceding notification is prepended in wire order.
 */
export function getEffectiveCursorUserMessageAction(
  action: ConversationAction["action"] | undefined
): UserMessageAction | undefined {
  if (action?.case === "userMessageAction") {
    return action.value
  }
  if (action?.case !== "subscriptionNotificationAction") {
    return undefined
  }

  const current = action.value.notifications.at(-1)
  if (!current) {
    return undefined
  }

  return create(UserMessageActionSchema, {
    userMessage: current,
    prependUserMessages: action.value.notifications.slice(0, -1),
    requestContext: action.value.requestContext,
    sendToInteractionListener: action.value.sendToInteractionListener,
  })
}
