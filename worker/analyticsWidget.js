// Moved to config/analyticsWidget.js so BOTH the worker and a /ai function can import it (a
// function may not import out of functions/, but functions/config is a symlink to config/).
// Re-exported here so every existing importer keeps working unchanged.
export { WIDGET_METRICS, WIDGET_KINDS, WIDGET_REFUSAL, parseWidgetSpec, validateWidget, widgetInstructions } from "../config/analyticsWidget.js";
