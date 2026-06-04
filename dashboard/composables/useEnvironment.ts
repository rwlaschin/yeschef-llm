// Shared dev/prod toggle state. The ConfigPanel writes it; pages/components
// (e.g. the Request page) read it and pass `env` to the server so requests
// target local (emulator) or production (real GCP) accordingly.
export type AppEnv = "local" | "production";

let hydrated = false;

export const useEnvironment = () => {
  const env = useState<AppEnv>("environment", () => "local");

  // hydrate from localStorage once per page load so the toggle survives reloads
  if (import.meta.client && !hydrated) {
    hydrated = true;
    const saved = window.localStorage.getItem("yeschef-llm-env");
    if (saved === "local" || saved === "production") env.value = saved;
  }

  const setEnv = (v: AppEnv) => {
    env.value = v;
    if (import.meta.client) window.localStorage.setItem("yeschef-llm-env", v);
  };

  return { env, setEnv };
};
