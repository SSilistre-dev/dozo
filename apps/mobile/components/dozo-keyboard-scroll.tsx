import type { ScrollViewProps } from "react-native";
import { ScrollView } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";

/**
 * A form's scroll view that shrinks above the keyboard, as New group does, so the fields below
 * the one being typed in stay reachable and the keyboard never covers them.
 */
export function DozoKeyboardScroll(props: ScrollViewProps) {
  return (
    <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
      <ScrollView {...props} />
    </KeyboardAvoidingView>
  );
}

/** Whether the keyboard is up, for a form that makes room by drawing smaller. */
export function useDozoKeyboardOpen(): boolean {
  return useKeyboardState((state) => state.isVisible);
}
