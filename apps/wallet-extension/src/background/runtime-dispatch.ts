import type {
  ProviderEventRuntimeMessage,
  RuntimeMessage
} from "../shared/messages";

/**
 * Runtime messages the background answers. provider_event travels the other
 * way (background to content scripts) and has no background handler.
 */
export type BackgroundRuntimeMessage = Exclude<
  RuntimeMessage,
  ProviderEventRuntimeMessage
>;

export type BackgroundMessageType = BackgroundRuntimeMessage["type"];

type BackgroundMessageByType = {
  [Message in BackgroundRuntimeMessage as Message["type"]]: Message;
};

/**
 * One handler per background message type: a missing or an unknown key is a
 * compile error. A handler's resolved value becomes the `ok` response.
 */
export type RuntimeHandlerTable = {
  [Type in BackgroundMessageType]: (
    message: BackgroundMessageByType[Type]
  ) => Promise<unknown>;
};

function hasHandler(
  handlers: RuntimeHandlerTable,
  message: RuntimeMessage
): message is BackgroundRuntimeMessage {
  return Object.hasOwn(handlers, message.type);
}

function invokeHandler<Type extends BackgroundMessageType>(
  handlers: RuntimeHandlerTable,
  type: Type,
  message: BackgroundMessageByType[Type]
): Promise<unknown> {
  const handler: (message: BackgroundMessageByType[Type]) => Promise<unknown> =
    handlers[type];
  return handler(message);
}

export async function dispatchRuntimeMessage(
  handlers: RuntimeHandlerTable,
  message: RuntimeMessage
): Promise<unknown> {
  if (!hasHandler(handlers, message)) {
    throw new Error("unsupported runtime message");
  }
  return invokeHandler(handlers, message.type, message);
}
