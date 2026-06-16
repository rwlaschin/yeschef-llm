import { fileURLToPath } from "node:url";

export default defineNuxtConfig({
  compatibilityDate: "2026-05-28",
  ssr: true,
  // Shared model registry lives in the parent infra repo (single source of truth).
  // Alias keeps the import clean + refactor-safe instead of a brittle ../../../../ path.
  alias: {
    "#models": fileURLToPath(new URL("../config/models.js", import.meta.url)),
    // Menu Plan workflow registry (pure: registry + composer, no admin/pubsub) — single source
    // shared with the /ai/menu endpoint so the form's fields can't drift from what composes.
    "#menu-plan": fileURLToPath(new URL("../functions/entry/ai/menu-plan.js", import.meta.url)),
  },
  // The model registry lives outside the dashboard root, so Nitro doesn't hot-reload
  // it by default — label/model edits wouldn't show until a manual restart. Watch it
  // explicitly so registry changes restart the dev server and the UI always matches config.
  watch: [
    fileURLToPath(new URL("../config/models.js", import.meta.url)),
    fileURLToPath(new URL("../functions/entry/ai/menu-plan.js", import.meta.url)),
  ],
  css: ["~/assets/css/main.css"],
  modules: [
    ["@nuxtjs/tailwindcss", {}],
    ["@nuxtjs/color-mode", {}],
  ],
  vite: {
    optimizeDeps: {
      exclude: ["nuxt"],
    },
  },
  nitro: {
    compatibilityDate: '2026-05-28',
    prerender: {
      crawlLinks: false,
    },
  },
  colorMode: {
    preference: "system",
    fallback: "dark",
    classSuffix: "",
    storageKey: "yeschef-llm-theme",
  },
  postcss: {
    plugins: {
      tailwindcss: {},
      autoprefixer: {},
    },
  },
  tailwindcss: {
    config: {
      darkMode: "class",
      theme: {
        extend: {
          colors: {
            primary: "#f5a623",
            glass: {
              light: "rgba(255, 255, 255, 0.1)",
              dark: "rgba(0, 0, 0, 0.3)",
            },
          },
          backdropBlur: {
            xs: "2px",
          },
        },
      },
    },
  },
  runtimeConfig: {
    public: {
      mongoUri: process.env.MONGO_URI,
      mongoDb: process.env.MONGO_DB,
      gcpProjectId: process.env.GCP_PROJECT_ID,
      firestoreCollectionResults: process.env.NUXT_PUBLIC_FIRESTORE_COLLECTION_RESULTS,
      // Orchestrator (/ai) base URL — the dashboard picks one by the local/production
      // toggle (same toggle as Pub/Sub emulator vs real GCP). Both are deterministic
      // defaults; override only if the project/region/ports ever change.
      aiBaseUrl: process.env.NUXT_PUBLIC_AI_BASE_URL || "https://us-central1-yeschef-c572a.cloudfunctions.net/ai",
      aiBaseUrlLocal: process.env.NUXT_PUBLIC_AI_BASE_URL_LOCAL || "http://localhost:5101/yeschef-c572a/us-central1/ai",
      pubsubProject: process.env.GCP_PROJECT_ID,
      firebaseEmulatorHost: process.env.PUBSUB_EMULATOR_HOST || "localhost:8185",
      environment: process.env.ENVIRONMENT || "local",
      graphqlEndpoint: process.env.GRAPHQL_ENDPOINT,
      graphqlEndpointProd: process.env.GRAPHQL_ENDPOINT_PROD,
      firebaseApiKey: process.env.NUXT_PUBLIC_FIREBASE_API_KEY,
      firebaseAuthDomain: process.env.NUXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    },
  },
  hooks: {
    'build:before': () => {
      console.log('=== BUILD BEFORE HOOK ===')
      console.log('nuxt.config runtimeConfig:', {
        mongoUri: process.env.MONGO_URI ? '✓' : '✗ NULL',
        mongoDb: process.env.MONGO_DB ? '✓' : '✗ NULL',
        gcpProjectId: process.env.GCP_PROJECT_ID ? '✓' : '✗ NULL',
      })
    },
  },
});
