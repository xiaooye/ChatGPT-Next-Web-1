import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  ImagesResponseDataInner,
  type ChatCompletionResponseMessage,
} from "openai";
import {
  ControllerPool,
  requestChatStream,
  requestImage,
  requestWebSearch,
  requestWithPrompt,
} from "../requests";
import { trimTopic } from "../utils";

import Locale from "../locales";
import { showToast } from "../components/ui-lib";
import { ModelType } from "./config";
import { createEmptyMask, Mask } from "./mask";
import { REQUEST_TIMEOUT_MS, StoreKey } from "../constant";
import { api, RequestMessage } from "../client/api";
import { ChatControllerPool } from "../client/controller";
import { prettyObject } from "../utils/format";

export type ChatMessage = RequestMessage & {
  date: string;
  images?: ImagesResponseDataInner[];
  image_alt?: string;
  streaming?: boolean;
  isError?: boolean;
  id?: number;
  model?: ModelType;
  webContent?: string;
};

export function createMessage(override: Partial<ChatMessage>): ChatMessage {
  return {
    id: Date.now(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    webContent: undefined,
    ...override,
  };
}

export interface ChatStat {
  tokenCount: number;
  wordCount: number;
  charCount: number;
}

export interface ChatSession {
  id: number;

  topic: string;

  memoryPrompt: string;
  messages: ChatMessage[];
  stat: ChatStat;
  lastUpdate: number;
  lastSummarizeIndex: number;
  botHello: ChatMessage;
  mask: Mask;
}

export const DEFAULT_TOPIC = Locale.Store.DefaultTopic;
const BOT_HELLO: ChatMessage = createMessage({
  role: "assistant",
  content: Locale.Store.BotHello,
});
const createBotHelloWithCommand = (command: string): ChatMessage => {
  BOT_HELLO.content = Locale.Store.BotHelloWithCommand(command);
  return BOT_HELLO;
};

function createEmptySession(): ChatSession {
  const mask = createEmptyMask();
  return {
    id: Date.now() + Math.random(),
    topic: DEFAULT_TOPIC,
    memoryPrompt: "",
    messages: [],
    stat: {
      tokenCount: 0,
      wordCount: 0,
      charCount: 0,
    },
    lastUpdate: Date.now(),
    lastSummarizeIndex: 0,
    mask: mask,
    botHello: createBotHelloWithCommand(mask.imageModelConfig.command),
  };
}

interface ChatStore {
  sessions: ChatSession[];
  currentSessionIndex: number;
  globalId: number;
  clearSessions: () => void;
  moveSession: (from: number, to: number) => void;
  selectSession: (index: number) => void;
  newSession: (mask?: Mask) => void;
  deleteSession: (index: number) => void;
  currentSession: () => ChatSession;
  onNewMessage: (message: ChatMessage) => void;
  onUserInput: (content: string, isWebSearch: boolean) => Promise<void>;
  summarizeSession: () => void;
  updateStat: (message: ChatMessage) => void;
  updateCurrentSession: (updater: (session: ChatSession) => void) => void;
  updateMessage: (
    sessionIndex: number,
    messageIndex: number,
    updater: (message?: ChatMessage) => void,
  ) => void;
  resetSession: () => void;
  getMessagesWithMemory: () => ChatMessage[];
  getMemoryPrompt: () => ChatMessage;

  clearAllData: () => void;
}

function countMessages(msgs: ChatMessage[]) {
  return msgs.reduce((pre, cur) => pre + cur.content.length, 0);
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      sessions: [createEmptySession()],
      currentSessionIndex: 0,
      globalId: 0,

      clearSessions() {
        set(() => ({
          sessions: [createEmptySession()],
          currentSessionIndex: 0,
        }));
      },

      selectSession(index: number) {
        set({
          currentSessionIndex: index,
        });
      },

      moveSession(from: number, to: number) {
        set((state) => {
          const { sessions, currentSessionIndex: oldIndex } = state;

          // move the session
          const newSessions = [...sessions];
          const session = newSessions[from];
          newSessions.splice(from, 1);
          newSessions.splice(to, 0, session);

          // modify current session id
          let newIndex = oldIndex === from ? to : oldIndex;
          if (oldIndex > from && oldIndex <= to) {
            newIndex -= 1;
          } else if (oldIndex < from && oldIndex >= to) {
            newIndex += 1;
          }

          return {
            currentSessionIndex: newIndex,
            sessions: newSessions,
          };
        });
      },

      newSession(mask) {
        const session = createEmptySession();

        set(() => ({ globalId: get().globalId + 1 }));
        session.id = get().globalId;

        if (mask) {
          session.mask = { ...mask };
          session.topic = mask.name;
        }

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [session].concat(state.sessions),
        }));
      },

      deleteSession(index) {
        const deletingLastSession = get().sessions.length === 1;
        const deletedSession = get().sessions.at(index);

        if (!deletedSession) return;

        const sessions = get().sessions.slice();
        sessions.splice(index, 1);

        const currentIndex = get().currentSessionIndex;
        let nextIndex = Math.min(
          currentIndex - Number(index < currentIndex),
          sessions.length - 1,
        );

        if (deletingLastSession) {
          nextIndex = 0;
          sessions.push(createEmptySession());
        }

        // for undo delete action
        const restoreState = {
          currentSessionIndex: get().currentSessionIndex,
          sessions: get().sessions.slice(),
        };

        set(() => ({
          currentSessionIndex: nextIndex,
          sessions,
        }));

        showToast(
          Locale.Home.DeleteToast,
          {
            text: Locale.Home.Revert,
            onClick() {
              set(() => restoreState);
            },
          },
          5000,
        );
      },

      currentSession() {
        let index = get().currentSessionIndex;
        const sessions = get().sessions;

        if (index < 0 || index >= sessions.length) {
          index = Math.min(sessions.length - 1, Math.max(0, index));
          set(() => ({ currentSessionIndex: index }));
        }

        const session = sessions[index];

        return session;
      },

      onNewMessage(message) {
        get().updateCurrentSession((session) => {
          session.lastUpdate = Date.now();
        });
        get().updateStat(message);
        get().summarizeSession();
      },

      async onUserInput(content, isWebSearch) {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;
        const imageModelConfig = session.mask.imageModelConfig;

        const userMessage: ChatMessage = createMessage({
          role: "user",
          content,
        });

        const botMessage: ChatMessage = createMessage({
          role: "assistant",
          streaming: true,
          id: userMessage.id! + 1,
          model: modelConfig.model,
        });

        const systemInfo = createMessage({
          role: "system",
          content: `IMPORTANT: You are a virtual assistant powered by the ${
            modelConfig.model
          } model, now time is ${new Date().toLocaleString()}}`,
          id: botMessage.id! + 1,
        });

        // get recent messages
        const systemMessages = [systemInfo];
        const recentMessages = get().getMessagesWithMemory();
        const sendMessages = systemMessages.concat(
          recentMessages.concat(userMessage),
        );
        const sessionIndex = get().currentSessionIndex;
        const messageIndex = get().currentSession().messages.length + 1;

        // save user's and bot's message
        get().updateCurrentSession((session) => {
          session.messages.push(userMessage);
        });
        if (isWebSearch) {
          const query = encodeURIComponent(content);
          const body = await requestWebSearch(query);
          const webSearchPrompt = `
Using the provided web search results, write a comprehensive reply to the given query.
If the provided search results refer to multiple subjects with the same name, write separate answers for each subject.
Make sure to cite results using \`[[number](URL)]\` notation after the reference.

Web search json results:
"""
${JSON.stringify(body)}
"""

Current date:
"""
${new Date().toISOString()}
"""

Query:
"""
${content}
"""

Reply in Chinese and markdown.
          `;
          userMessage.webContent = webSearchPrompt;
        }
        // save user's and bot's message
        get().updateCurrentSession((session) => {
          session.messages.push(botMessage);
        });

        if (
          userMessage.content
            .trim()
            .toLowerCase()
            .startsWith(imageModelConfig.command.toLowerCase())
        ) {
          const keyword = userMessage.content.substring(
            imageModelConfig.command.toLowerCase().length,
          );
          console.log("keyword", keyword);
          requestImage(keyword, {
            onMessage(content, images, image_alt, done) {
              // stream response
              if (done) {
                botMessage.streaming = false;
                botMessage.content = content!;
                botMessage.images = images!;
                botMessage.image_alt = image_alt!;
                get().onNewMessage(botMessage);
                ControllerPool.remove(
                  sessionIndex,
                  botMessage.id ?? messageIndex,
                );
              } else {
                botMessage.image_alt = image_alt!;
                set(() => ({}));
              }
            },
            onError(error, statusCode) {
              const isAborted = error.message.includes("aborted");
              if (statusCode === 401) {
                botMessage.content = Locale.Error.Unauthorized;
              } else if (!isAborted) {
                botMessage.content += "\n\n" + Locale.Store.Error;
              }
              botMessage.streaming = false;
              userMessage.isError = !isAborted;
              botMessage.isError = !isAborted;

              set(() => ({}));
              ControllerPool.remove(
                sessionIndex,
                botMessage.id ?? messageIndex,
              );
            },
            onController(controller) {
              // collect controller for stop/retry
              ControllerPool.addController(
                sessionIndex,
                botMessage.id ?? messageIndex,
                controller,
              );
            },
          });
        } else {
          // make request
          console.log("[User Input] ", sendMessages);
          requestChatStream(sendMessages, {
            onMessage(content, done) {
              // stream response
              if (done) {
                botMessage.streaming = false;
                botMessage.content = content;
                get().onNewMessage(botMessage);
                ControllerPool.remove(
                  sessionIndex,
                  botMessage.id ?? messageIndex,
                );
              } else {
                botMessage.content = content;
                set(() => ({}));
              }
            },
            onError(error, statusCode) {
              const isAborted = error.message.includes("aborted");
              if (statusCode === 401) {
                botMessage.content = Locale.Error.Unauthorized;
              } else if (!isAborted) {
                botMessage.content += "\n\n" + Locale.Store.Error;
              }
              botMessage.streaming = false;
              userMessage.isError = !isAborted;
              botMessage.isError = !isAborted;

              set(() => ({}));
              ControllerPool.remove(
                sessionIndex,
                botMessage.id ?? messageIndex,
              );
            },
            onController(controller) {
              // collect controller for stop/retry
              ControllerPool.addController(
                sessionIndex,
                botMessage.id ?? messageIndex,
                controller,
              );
            },
            modelConfig: { ...modelConfig },
          });
        }
      },

      getMemoryPrompt() {
        const session = get().currentSession();

        return {
          role: "system",
          content:
            session.memoryPrompt.length > 0
              ? Locale.Store.Prompt.History(session.memoryPrompt)
              : "",
          date: "",
        } as ChatMessage;
      },

      getMessagesWithMemory() {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;
        const messages = session.messages.filter((msg) => !msg.isError);
        const n = messages.length;

        const context = session.mask.context.slice();

        // long term memory
        if (
          modelConfig.sendMemory &&
          session.memoryPrompt &&
          session.memoryPrompt.length > 0
        ) {
          const memoryPrompt = get().getMemoryPrompt();
          context.push(memoryPrompt);
        }

        // get short term and unmemoried long term memory
        const shortTermMemoryMessageIndex = Math.max(
          0,
          n - modelConfig.historyMessageCount,
        );
        const longTermMemoryMessageIndex = session.lastSummarizeIndex;
        const oldestIndex = Math.max(
          shortTermMemoryMessageIndex,
          longTermMemoryMessageIndex,
        );
        const threshold = modelConfig.compressMessageLengthThreshold;

        // get recent messages as many as possible
        const reversedRecentMessages = [];
        for (
          let i = n - 1, count = 0;
          i >= oldestIndex && count < threshold;
          i -= 1
        ) {
          const msg = messages[i];
          if (!msg || msg.isError) continue;
          count += msg.content.length;
          reversedRecentMessages.push(msg);
        }

        // concat
        const recentMessages = context.concat(reversedRecentMessages.reverse());

        return recentMessages;
      },

      updateMessage(
        sessionIndex: number,
        messageIndex: number,
        updater: (message?: ChatMessage) => void,
      ) {
        const sessions = get().sessions;
        const session = sessions.at(sessionIndex);
        const messages = session?.messages;
        updater(messages?.at(messageIndex));
        set(() => ({ sessions }));
      },

      resetSession() {
        get().updateCurrentSession((session) => {
          session.messages = [];
          session.memoryPrompt = "";
        });
      },

      summarizeSession() {
        const session = get().currentSession();

        // remove error messages if any
        const cleanMessages = session.messages.filter((msg) => !msg.isError);

        // should summarize topic after chating more than 50 words
        const SUMMARIZE_MIN_LEN = 50;
        if (
          session.topic === DEFAULT_TOPIC &&
          countMessages(cleanMessages) >= SUMMARIZE_MIN_LEN
        ) {
          const topicMessages = cleanMessages.concat(
            createMessage({
              role: "user",
              content: Locale.Store.Prompt.Topic,
            }),
          );
          api.llm.chat({
            messages: topicMessages,
            config: {
              model: "gpt-3.5-turbo",
            },
            onFinish(message) {
              get().updateCurrentSession(
                (session) =>
                  (session.topic =
                    message.length > 0 ? trimTopic(message) : DEFAULT_TOPIC),
              );
            },
          });
        }

        const modelConfig = session.mask.modelConfig;
        let toBeSummarizedMsgs = cleanMessages.slice(
          session.lastSummarizeIndex,
        );

        const historyMsgLength = countMessages(toBeSummarizedMsgs);

        if (historyMsgLength > modelConfig?.max_tokens ?? 4000) {
          const n = toBeSummarizedMsgs.length;
          toBeSummarizedMsgs = toBeSummarizedMsgs.slice(
            Math.max(0, n - modelConfig.historyMessageCount),
          );
        }

        // add memory prompt
        toBeSummarizedMsgs.unshift(get().getMemoryPrompt());

        const lastSummarizeIndex = session.messages.length;

        console.log(
          "[Chat History] ",
          toBeSummarizedMsgs,
          historyMsgLength,
          modelConfig.compressMessageLengthThreshold,
        );

        if (
          historyMsgLength > modelConfig.compressMessageLengthThreshold &&
          session.mask.modelConfig.sendMemory
        ) {
          api.llm.chat({
            messages: toBeSummarizedMsgs.concat({
              role: "system",
              content: Locale.Store.Prompt.Summarize,
              date: "",
            }),
            config: { ...modelConfig, stream: true },
            onUpdate(message) {
              session.memoryPrompt = message;
            },
            onFinish(message) {
              console.log("[Memory] ", message);
              session.lastSummarizeIndex = lastSummarizeIndex;
            },
            onError(err) {
              console.error("[Summarize] ", err);
            },
          });
        }
      },

      updateStat(message) {
        get().updateCurrentSession((session) => {
          session.stat.charCount += message.content.length;
          // TODO: should update chat count and word count
        });
      },

      updateCurrentSession(updater) {
        const sessions = get().sessions;
        const index = get().currentSessionIndex;
        updater(sessions[index]);
        set(() => ({ sessions }));
      },

      clearAllData() {
        localStorage.clear();
        location.reload();
      },
    }),
    {
      name: StoreKey.Chat,
      version: 2,
      migrate(persistedState, version) {
        const state = persistedState as any;
        const newState = JSON.parse(JSON.stringify(state)) as ChatStore;

        if (version < 2) {
          newState.globalId = 0;
          newState.sessions = [];

          const oldSessions = state.sessions;
          for (const oldSession of oldSessions) {
            const newSession = createEmptySession();
            newSession.topic = oldSession.topic;
            newSession.messages = [...oldSession.messages];
            newSession.mask.modelConfig.sendMemory = true;
            newSession.mask.modelConfig.historyMessageCount = 4;
            newSession.mask.modelConfig.compressMessageLengthThreshold = 1000;
            newState.sessions.push(newSession);
          }
        }

        return newState;
      },
    },
  ),
);
