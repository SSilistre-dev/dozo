import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

/**
 * Opens the share sheet with a table as a CSV file. The BOM makes spreadsheet apps read UTF-8, as
 * the web download does. A device without sharing keeps the file in the cache and says nothing:
 * the button is a convenience, not a step a reply depends on.
 */
export async function shareCsv(csv: string): Promise<void> {
  const dir = new Directory(Paths.cache, "table-shares");
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, "table.csv");
  file.create({ overwrite: true });
  file.write(`﻿${csv}`);
  if (!(await Sharing.isAvailableAsync())) return;
  await Sharing.shareAsync(file.uri, {
    mimeType: "text/csv",
    UTI: "public.comma-separated-values-text",
  });
}
