import pino from "pino";

let logger: ReturnType<typeof pino> | null = null;

export const useLogger = (name: string) => {
  if (process.server) {
    return {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    };
  }

  if (!logger) {
    // Custom localStorage transport for Pino
    const localStorageTransport = {
      write(chunk: string) {
        try {
          const logs = JSON.parse(
            localStorage.getItem("yeschef-llm-logs") || "[]"
          );
          const log = JSON.parse(chunk);
          logs.push({
            ...log,
            timestamp: new Date().toISOString(),
          });

          // Keep only last 100 logs
          if (logs.length > 100) {
            logs.shift();
          }

          localStorage.setItem("yeschef-llm-logs", JSON.stringify(logs));
        } catch (err) {
          console.error("Failed to write to localStorage:", err);
        }
      },
    };

    logger = pino(
      {
        level: "info",
        base: { module: name },
        transport: {
          target: "pino/browser",
          options: {
            write: localStorageTransport.write,
          },
        },
      }
    );
  }

  return logger.child({ module: name });
};

export const useLogs = () => {
  const logs = ref<any[]>([]);

  const loadLogs = () => {
    try {
      const stored = localStorage.getItem("yeschef-llm-logs");
      logs.value = stored ? JSON.parse(stored) : [];
    } catch (err) {
      console.error("Failed to load logs:", err);
    }
  };

  const clearLogs = () => {
    localStorage.removeItem("yeschef-llm-logs");
    logs.value = [];
  };

  // Poll for new logs; self-cancels on unmount (no leaked interval).
  usePoll(loadLogs, 1000);

  return {
    logs,
    clearLogs,
    reload: loadLogs,
  };
};
