// Narrow, text-only glasses projection for TB0-C0.
// Raw DSH events never cross the glasses namespace. Only the fields needed to
// reconstruct one text conversation are retained.

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function baseProjection(evt) {
  return {
    seq: numberOrNull(evt?.seq),
    type: stringOrEmpty(evt?.type),
  };
}

export function projectEvent(evt) {
  const projected = baseProjection(evt);
  const data = evt?.data ?? {};

  if (projected.type === "user/message") {
    const source = data?.source ?? {};
    return {
      ...projected,
      message: {
        role: "user",
        id: stringOrEmpty(data?.id),
        text: textFromBlocks(data?.content),
        rpcId: source?.kind === "user" ? stringOrEmpty(source?.rpcId) : "",
      },
    };
  }

  if (projected.type === "assistant/message") {
    const message = data?.message ?? {};
    const source = message?.source ?? {};
    const usage = data?.usage ?? {};
    return {
      ...projected,
      turn: numberOrNull(data?.turn),
      step: numberOrNull(data?.step),
      message: {
        role: "assistant",
        id: stringOrEmpty(message?.id),
        text: textFromBlocks(message?.content),
        provider: stringOrEmpty(source?.provider),
        model: stringOrEmpty(source?.model),
      },
      usage: {
        inputTokens: numberOrNull(usage?.inputTokens),
        outputTokens: numberOrNull(usage?.outputTokens),
      },
    };
  }

  if (projected.type === "assistant/chunk") {
    const chunk = data?.chunk;
    if (!chunk || typeof chunk.type !== "string") return projected;

    const chunkProjection = { type: chunk.type };
    if (Number.isInteger(chunk.index)) chunkProjection.index = chunk.index;

    switch (chunk.type) {
      case "block-start":
        chunkProjection.blockType = stringOrEmpty(chunk.blockType);
        break;
      case "text-delta":
        chunkProjection.text = stringOrEmpty(chunk.text);
        break;
      case "block-end":
        if (chunk?.block?.type === "text") {
          chunkProjection.text = stringOrEmpty(chunk.block.text);
        }
        break;
      default:
        // Reasoning/tool/usage/finish payloads are deliberately not projected.
        break;
    }

    return {
      ...projected,
      turn: numberOrNull(data?.turn),
      step: numberOrNull(data?.step),
      chunk: chunkProjection,
    };
  }

  return projected;
}
