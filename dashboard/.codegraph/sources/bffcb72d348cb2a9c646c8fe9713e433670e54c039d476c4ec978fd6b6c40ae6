export interface Toast {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title: string;
  message?: string;
  duration?: number;
}

const toasts = ref<Toast[]>([]);

export const useToast = () => {
  const addToast = (
    type: Toast["type"],
    title: string,
    message?: string,
    duration = 4000
  ) => {
    const id = `toast-${Date.now()}`;
    const toast: Toast = { id, type, title, message, duration };

    toasts.value.push(toast);

    if (duration > 0) {
      setTimeout(() => removeToast(id), duration);
    }

    return id;
  };

  const removeToast = (id: string) => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  };

  const success = (title: string, message?: string) =>
    addToast("success", title, message);
  const error = (title: string, message?: string) =>
    addToast("error", title, message);
  const info = (title: string, message?: string) =>
    addToast("info", title, message);
  const warning = (title: string, message?: string) =>
    addToast("warning", title, message);

  return {
    toasts: readonly(toasts),
    addToast,
    removeToast,
    success,
    error,
    info,
    warning,
  };
};
