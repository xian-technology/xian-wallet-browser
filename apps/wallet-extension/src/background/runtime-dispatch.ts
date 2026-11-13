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

type KeysOfEach<T> = T extends unknown ? keyof T : never;

/** Message types that appear in more than one group of the tuple. */
type SharedHandlerKeys<Groups extends readonly unknown[]> =
  Groups extends readonly [infer Head, ...infer Tail]
    ? (keyof Head & KeysOfEach<Tail[number]>) | SharedHandlerKeys<Tail>
    : never;

type DisjointHandlerGroups<Groups extends readonly unknown[]> =
  [SharedHandlerKeys<Groups>] extends [never]
    ? Groups
    : Groups & { handledByMoreThanOneGroup: SharedHandlerKeys<Groups> };

/**
 * Returns the handler groups unchanged. A message type handled by more than
 * one group is a compile error that names it, so merging the groups can never
 * silently let one handler shadow another.
 */
export function disjointHandlerGroups<
  const Groups extends readonly Partial<RuntimeHandlerTable>[]
>(...groups: DisjointHandlerGroups<Groups>): Groups {
  return groups;
}

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
