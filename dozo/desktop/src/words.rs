//! The words of the menus and of the Settings window, in the system's language where we have it:
//! English, and Turkish when the system's language is Turkish. The other windows are English only.

/// English, and its Turkish.
const TURKISH: [(&str, &str); 36] = [
    ("Settings…", "Ayarlar…"),
    ("Settings", "Ayarlar"),
    ("Change Server…", "Sunucuyu Değiştir…"),
    ("Reload", "Yeniden Yükle"),
    ("Connect Phone…", "Telefonu Bağla…"),
    ("Back Up…", "Yedekle…"),
    ("Restore…", "Geri Yükle…"),
    ("Reset Password…", "Parolayı Sıfırla…"),
    ("Save Diagnostics…", "Tanılamayı Kaydet…"),
    ("Open at Login", "Açılışta Aç"),
    ("Keep Running in Background", "Arka Planda Çalış"),
    // `talk::LABEL` on macOS, and on Windows and Linux.
    ("Push to Talk (⇧⌘Space)", "Bas ve Konuş (⇧⌘Space)"),
    (
        "Push to Talk (Ctrl+Shift+Space)",
        "Bas ve Konuş (Ctrl+Shift+Space)",
    ),
    ("Licenses", "Lisanslar"),
    ("Version", "Sürüm"),
    ("Quit", "Çık"),
    ("Open Dozo", "Dozo'yu Aç"),
    ("Quit Dozo", "Dozo'dan Çık"),
    ("Edit", "Düzen"),
    ("View", "Görünüm"),
    ("Window", "Pencere"),
    ("About Dozo", "Dozo Hakkında"),
    ("Services", "Servisler"),
    ("Hide Dozo", "Dozo'yu Gizle"),
    ("Hide Others", "Diğerlerini Gizle"),
    ("Show All", "Tümünü Göster"),
    ("Undo", "Geri Al"),
    ("Redo", "Yinele"),
    ("Cut", "Kes"),
    ("Copy", "Kopyala"),
    ("Paste", "Yapıştır"),
    ("Select All", "Tümünü Seç"),
    ("Minimize", "Küçült"),
    ("Zoom", "Büyüt"),
    ("Toggle Full Screen", "Tam Ekran"),
    ("Close Window", "Pencereyi Kapat"),
];

/// Whether the system's language is Turkish.
pub fn turkish() -> bool {
    is_turkish(sys_locale::get_locale().as_deref())
}

pub fn is_turkish(locale: Option<&str>) -> bool {
    locale.is_some_and(|locale| locale.to_ascii_lowercase().starts_with("tr"))
}

/// `english` in the system's language.
pub fn text(english: &'static str) -> &'static str {
    in_language(turkish(), english)
}

/// The system's own words for a standard item (the system names it in English), or ours in
/// Turkish. Only macOS has these items.
#[cfg(target_os = "macos")]
pub fn standard(english: &'static str) -> Option<&'static str> {
    turkish().then(|| in_language(true, english))
}

fn in_language(turkish: bool, english: &'static str) -> &'static str {
    TURKISH
        .iter()
        .find(|(en, _)| turkish && *en == english)
        .map_or(english, |(_, tr)| tr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turkish_where_the_system_is_turkish_and_english_elsewhere() {
        assert!(is_turkish(Some("tr-TR")));
        assert!(is_turkish(Some("TR")));
        assert!(!is_turkish(Some("en-US")));
        assert!(!is_turkish(None));
        assert_eq!(in_language(true, "Back Up…"), "Yedekle…");
        assert_eq!(in_language(false, "Back Up…"), "Back Up…");
        // Words without a Turkish entry stay English.
        assert_eq!(in_language(true, "Dozo"), "Dozo");
        // A label kept elsewhere still has its Turkish.
        assert_ne!(in_language(true, crate::talk::LABEL), crate::talk::LABEL);
    }

    #[test]
    fn each_english_entry_is_listed_once() {
        for (i, (en, tr)) in TURKISH.iter().enumerate() {
            assert!(!tr.is_empty() && tr != en, "{en}");
            assert!(
                TURKISH[i + 1..].iter().all(|(other, _)| other != en),
                "{en}"
            );
        }
    }
}
