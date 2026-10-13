type ConfirmRequest = {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  resolve: (confirmed: boolean) => void;
};

class Feedback {
  confirm = $state<ConfirmRequest | null>(null);
  toast = $state<{ id: number; message: string } | null>(null);
  #toastTimer: ReturnType<typeof setTimeout> | null = null;

  ask(request: Omit<ConfirmRequest, "resolve">) {
    this.confirm?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.confirm = { ...request, resolve };
    });
  }

  settle(confirmed: boolean) {
    this.confirm?.resolve(confirmed);
    this.confirm = null;
  }

  notify(message: string) {
    if (this.#toastTimer) clearTimeout(this.#toastTimer);
    this.toast = { id: (this.toast?.id ?? 0) + 1, message };
    this.#toastTimer = setTimeout(() => (this.toast = null), 2400);
  }
}

export const feedback = new Feedback();
