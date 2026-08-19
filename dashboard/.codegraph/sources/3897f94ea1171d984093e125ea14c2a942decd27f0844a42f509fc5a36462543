export default defineEventHandler(async (event) => {
  try {
    const response = await fetch("http://localhost:11434/api/tags");

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    return { status: "ok" };
  } catch (err) {
    throw createError({
      statusCode: 503,
      statusMessage: `Ollama connection failed: ${err.message}`,
    });
  }
});
