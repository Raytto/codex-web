export type ComposerPrimaryAction = "send" | "stop";

export function chooseComposerPrimaryAction({
  running,
  hasText,
  hasAttachments,
  voiceActive,
}: {
  running: boolean;
  hasText: boolean;
  hasAttachments: boolean;
  voiceActive: boolean;
}): ComposerPrimaryAction {
  return running && !hasText && !hasAttachments && !voiceActive ? "stop" : "send";
}
