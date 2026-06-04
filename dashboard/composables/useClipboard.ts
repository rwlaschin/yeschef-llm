export const useClipboard = () => {
  const { success, error } = useToast();

  const copy = async (text: string, label = "Copied") => {
    try {
      await navigator.clipboard.writeText(text);
      success(label, text.substring(0, 50) + (text.length > 50 ? "..." : ""));
    } catch (err) {
      error("Copy failed", err.message);
    }
  };

  return {
    copy,
  };
};
