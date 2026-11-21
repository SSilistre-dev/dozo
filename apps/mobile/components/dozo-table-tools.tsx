import type { TableToolsProps } from "@rakazo/chat-ui/native";
import { useMarkdownCopy } from "@rakazo/chat-ui/native";
import { useState } from "react";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { shareCsv } from "../lib/dozo-table-share";
import { NativeActionButton } from "./native-action-button";

/** The controls beside a chat table: share it as CSV, and open it full screen. */
export function TableTools({ csv, renderTable }: TableToolsProps) {
  const copy = useMarkdownCopy();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.row}>
      <NativeActionButton
        accessibilityLabel={copy.downloadCsv}
        icon={{ ios: "square.and.arrow.up", android: "share-outline" }}
        prominence="quiet"
        size="compact"
        onPress={() => void shareCsv(csv).catch(() => undefined)}
      />
      <NativeActionButton
        accessibilityLabel={copy.expandTable}
        icon={{ ios: "arrow.up.left.and.arrow.down.right", android: "expand-outline" }}
        prominence="quiet"
        size="compact"
        onPress={() => setOpen(true)}
      />
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView style={styles.screen}>
          <View style={styles.row}>
            <NativeActionButton
              accessibilityLabel={copy.closeTable}
              icon={{ ios: "xmark", android: "close" }}
              prominence="quiet"
              size="compact"
              onPress={() => setOpen(false)}
            />
          </View>
          <ScrollView contentContainerStyle={styles.content}>{renderTable()}</ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "flex-end", gap: 4 },
  screen: { flex: 1 },
  content: { padding: 12 },
});
