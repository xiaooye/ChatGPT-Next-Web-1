import type { ChatRequest, ChatResponse } from "./api/openai/typing";
import {
  ChatMessage,
  ModelConfig,
  ModelType,
  useAccessStore,
  useAppConfig,
  useChatStore,
} from "./store";
import { showToast } from "./components/ui-lib";
import { ACCESS_CODE_PREFIX, IMAGE_ERROR, IMAGE_PLACEHOLDER } from "./constant";
import {
  CreateImageRequest,
  CreateImageRequestResponseFormatEnum,
  CreateImageRequestSizeEnum,
  ImagesResponse,
  ImagesResponseDataInner,
} from "openai";
const TIME_OUT_MS = 60000;

const makeRequestParam = (
  messages: ChatMessage[],
  options?: {
    stream?: boolean;
    overrideModel?: ModelType;
  },
): ChatRequest => {
  let sendMessages = messages.map((v) => ({
    role: v.role,
    content: v.webContent ?? v.content,
  }));

  const modelConfig = {
    ...useAppConfig.getState().modelConfig,
    ...useChatStore.getState().currentSession().mask.modelConfig,
  };

  // override model config
  if (options?.overrideModel) {
    modelConfig.model = options.overrideModel;
  }

  return {
    messages: sendMessages,
    stream: options?.stream,
    model: modelConfig.model,
    temperature: modelConfig.temperature,
    presence_penalty: modelConfig.presence_penalty,
  };
};

export function getHeaders() {
  const accessStore = useAccessStore.getState();
  let headers: Record<string, string> = {};

  const makeBearer = (token: string) => `Bearer ${token.trim()}`;
  const validString = (x: string) => x && x.length > 0;

  // use user's api key first
  if (validString(accessStore.token)) {
    headers.Authorization = makeBearer(accessStore.token);
  } else if (
    accessStore.enabledAccessControl() &&
    validString(accessStore.accessCode)
  ) {
    headers.Authorization = makeBearer(
      ACCESS_CODE_PREFIX + accessStore.accessCode,
    );
  }

  return headers;
}

export function requestOpenaiClient(path: string) {
  const openaiUrl = useAccessStore.getState().openaiUrl;
  return (body: any, method = "POST") =>
    fetch(openaiUrl + path, {
      method,
      body: body && JSON.stringify(body),
      headers: getHeaders(),
    });
}

export async function requestChat(
  messages: ChatMessage[],
  options?: {
    model?: ModelType;
  },
) {
  const req: ChatRequest = makeRequestParam(messages, {
    overrideModel: options?.model,
  });

  const res = await requestOpenaiClient("v1/chat/completions")(req);

  try {
    const response = (await res.json()) as ChatResponse;
    return response;
  } catch (error) {
    console.error("[Request Chat] ", error, res.body);
  }
}

export async function requestWebSearch(query: string) {
  const res = await fetch(`/api/web-search?query=${query}`, {
    method: "GET",
    headers: {
      ...getHeaders(),
    },
  });

  try {
    return await res.json();
  } catch (error) {
    //console.error("[Request Web Search] ", error, res.body);
  }
}

export async function requestUsage() {
  const formatDate = (d: Date) =>
    `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
      .getDate()
      .toString()
      .padStart(2, "0")}`;
  const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startDate = formatDate(startOfMonth);
  const endDate = formatDate(new Date(Date.now() + ONE_DAY));

  const [used, subs] = await Promise.all([
    requestOpenaiClient(
      `dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`,
    )(null, "GET"),
    requestOpenaiClient("dashboard/billing/subscription")(null, "GET"),
  ]);

  const response = (await used.json()) as {
    total_usage?: number;
    error?: {
      type: string;
      message: string;
    };
  };

  const total = (await subs.json()) as {
    hard_limit_usd?: number;
  };

  if (response.error && response.error.type) {
    showToast(response.error.message);
    return;
  }

  if (response.total_usage) {
    response.total_usage = Math.round(response.total_usage) / 100;
  }

  if (total.hard_limit_usd) {
    total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
  }

  return {
    used: response.total_usage,
    subscription: total.hard_limit_usd,
  };
}
const makeImageRequestParam = (
  prompt: string,
  options?: Omit<CreateImageRequest, "prompt">,
): CreateImageRequest => {
  // Set default values
  const defaultOptions: Omit<CreateImageRequest, "prompt"> = {
    n: useAppConfig.getState().imageModelConfig.noOfImage,
    response_format: CreateImageRequestResponseFormatEnum.Url,
    user: "default_user",
    size: useAppConfig.getState().imageModelConfig.size,
  };

  // Override default values with provided options
  const finalOptions = { ...defaultOptions, ...options };

  const request: CreateImageRequest = {
    prompt,
    ...finalOptions,
  };

  return request;
};
export async function requestImage(
  keyword: string,
  options?: {
    onMessage: (
      message: string | null,
      image: ImagesResponseDataInner[] | null,
      image_alt: string | null,
      done: boolean,
    ) => void;
    onError: (error: Error, statusCode?: number) => void;
    onController?: (controller: AbortController) => void;
  },
) {
  if (keyword.length < 1) {
    options?.onMessage(
      "Please enter a keyword after `/image`",
      null,
      null,
      true,
    );
  } else {
    const controller = new AbortController();
    const reqTimeoutId = setTimeout(() => controller.abort(), TIME_OUT_MS);
    options?.onController?.(controller);

    async function fetchImageAndUpdateMessage() {
      try {
        options?.onMessage(null, null, IMAGE_PLACEHOLDER, false);

        const sanitizedMessage = keyword.replace(/[\n\r]+/g, " ");
        const req = makeImageRequestParam(sanitizedMessage);

        const res = await requestOpenaiClient("v1/images/generations")(req);

        clearTimeout(reqTimeoutId);

        const finish = (images: ImagesResponseDataInner[]) => {
          options?.onMessage("Here is your images", images, null, true);
          controller.abort();
        };

        if (res.ok) {
          const responseData = (await res.json()) as ImagesResponse;
          finish(responseData.data);
        } else if (res.status === 401) {
          console.error("Unauthorized");
          options?.onError(new Error("Unauthorized"), res.status);
        } else {
          console.error("Stream Error", res.body);
          options?.onError(new Error("Stream Error"), res.status);
        }
      } catch (err) {
        console.error("NetWork Error", err);
        options?.onError(err as Error);
        options?.onMessage(
          "Image generation has been cancelled.",
          null,
          IMAGE_ERROR,
          true,
        );
      }
    }
    fetchImageAndUpdateMessage();
  }
}

export async function requestChatStream(
  messages: ChatMessage[],
  options?: {
    modelConfig?: ModelConfig;
    overrideModel?: ModelType;
    onMessage: (message: string, done: boolean) => void;
    onError: (error: Error, statusCode?: number) => void;
    onController?: (controller: AbortController) => void;
  },
) {
  const req = makeRequestParam(messages, {
    stream: true,
    overrideModel: options?.overrideModel,
  });

  console.log("[Request] ", req);

  const controller = new AbortController();
  const reqTimeoutId = setTimeout(() => controller.abort(), TIME_OUT_MS);

  try {
    const openaiUrl = useAccessStore.getState().openaiUrl;
    const res = await fetch(openaiUrl + "v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getHeaders(),
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });

    clearTimeout(reqTimeoutId);

    let responseText = "";

    const finish = () => {
      options?.onMessage(responseText, true);
      controller.abort();
    };

    if (res.ok) {
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      options?.onController?.(controller);
      let substr = "";
      while (true) {
        const resTimeoutId = setTimeout(() => finish(), TIME_OUT_MS);
        const content = await reader?.read();
        clearTimeout(resTimeoutId);

        if (!content || !content.value) {
          break;
        }

        const text = decoder
          .decode(content.value, { stream: true })
          .toString()
          .split("\n")
          .filter((line) => line.trim() !== "");

        for (const line of text) {
          const message = line.replace(/^data: /, "");
          if (message === "[DONE]") {
            return; // Stream finished
          }
          try {
            const parsed = JSON.parse(message);
            if ("content" in parsed.choices[0].delta)
              responseText += parsed.choices[0].delta?.content;
          } catch (error) {
            if (substr === "") {
              substr = message;
            } else {
              try {
                const parsed = JSON.parse(substr + message);
                substr = "";
                if ("content" in parsed.choices[0].delta)
                  responseText += parsed.choices[0].delta?.content;
              } catch (error) {
                console.error(
                  "Could not JSON parse stream message",
                  message,
                  error,
                );
                substr += message;
              }
            }
          }
        }

        const done = content.done;
        options?.onMessage(responseText, false);

        if (done) {
          break;
        }
      }

      finish();
    } else if (res.status === 401) {
      console.error("Unauthorized");
      options?.onError(new Error("Unauthorized"), res.status);
    } else {
      console.error("Stream Error", res.body);
      options?.onError(new Error("Stream Error"), res.status);
    }
  } catch (err) {
    console.error("NetWork Error", err);
    options?.onError(err as Error);
  }
}

export async function requestWithPrompt(
  messages: ChatMessage[],
  prompt: string,
  options?: {
    model?: ModelType;
  },
) {
  messages = messages.concat([
    {
      role: "user",
      content: prompt,
      date: new Date().toLocaleString(),
    },
  ]);

  const res = await requestChat(messages, options);

  return res?.choices?.at(0)?.message?.content ?? "";
}

// To store message streaming controller
export const ControllerPool = {
  controllers: {} as Record<string, AbortController>,

  addController(
    sessionIndex: number,
    messageId: number,
    controller: AbortController,
  ) {
    const key = this.key(sessionIndex, messageId);
    this.controllers[key] = controller;
    return key;
  },

  stop(sessionIndex: number, messageId: number) {
    const key = this.key(sessionIndex, messageId);
    const controller = this.controllers[key];
    controller?.abort();
  },

  stopAll() {
    Object.values(this.controllers).forEach((v) => v.abort());
  },

  hasPending() {
    return Object.values(this.controllers).length > 0;
  },

  remove(sessionIndex: number, messageId: number) {
    const key = this.key(sessionIndex, messageId);
    delete this.controllers[key];
  },

  key(sessionIndex: number, messageIndex: number) {
    return `${sessionIndex},${messageIndex}`;
  },
};
