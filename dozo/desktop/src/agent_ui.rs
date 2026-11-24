//! The question an agent on this computer asks the person before it goes on (`device_agent.rs`):
//! a small window of the app's own (`ui/agent.html`), never the page of any server and not a
//! system dialog, which cannot be closed from here. Cancel has the focus, so Enter and Escape
//! refuse, and closing the window refuses too; when the time to answer runs out, the window
//! closes itself. It is built the way the login question is (`passwords_ui.rs`, whose `relay` it
//! shares), and only its own page can call its commands (`capabilities/agent.json`).

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::oneshot;

use crate::words::text;

const WINDOW: &str = "agent";

/// The question on screen: its text, and where its answer goes.
#[derive(Default)]
pub struct AgentQuestion {
    open: Mutex<Option<Open>>,
    count: AtomicU64,
}

struct Open {
    id: u64,
    text: String,
    answer: oneshot::Sender<bool>,
}

#[cfg_attr(not(unix), allow(dead_code))]
impl AgentQuestion {
    /// Puts a question up, in place of any other (which is refused). Answers its id and where its
    /// answer comes from.
    fn put(&self, text: &str) -> (u64, oneshot::Receiver<bool>) {
        let (answer, answered) = oneshot::channel();
        let id = self.count.fetch_add(1, Ordering::SeqCst);
        *self.open.lock().unwrap() = Some(Open {
            id,
            text: text.to_owned(),
            answer,
        });
        (id, answered)
    }

    fn words(&self) -> Option<String> {
        self.open
            .lock()
            .unwrap()
            .as_ref()
            .map(|open| open.text.clone())
    }

    /// The person's answer, or a refusal when the window is gone. Only the first one counts.
    fn answer(&self, allow: bool) {
        if let Some(open) = self.open.lock().unwrap().take() {
            let _ = open.answer.send(allow);
        }
    }

    /// The question `id` is over; true when it was the one on screen (its window should close).
    fn end(&self, id: u64) -> bool {
        let mut open = self.open.lock().unwrap();
        if open.as_ref().is_some_and(|open| open.id == id) {
            *open = None;
            return true;
        }
        false
    }
}

#[cfg(unix)]
pub struct AgentDialogs(pub AppHandle);

#[cfg(unix)]
impl crate::device_agent::Approvals for AgentDialogs {
    fn ask(&self, text: &str) -> oneshot::Receiver<bool> {
        let (asked, answered) = oneshot::channel();
        let app = self.0.clone();
        let (id, page) = app.state::<AgentQuestion>().put(text);
        let shown = app.clone();
        let _ = app.run_on_main_thread(move || show_question(&shown));
        tauri::async_runtime::spawn(async move {
            crate::passwords_ui::relay(asked, page).await;
            // Answered, or nobody waits any more (the time ran out, the turn ended): the window
            // goes either way.
            if app.state::<AgentQuestion>().end(id) {
                let _ = app.run_on_main_thread({
                    let app = app.clone();
                    move || {
                        if let Some(window) = app.get_webview_window(WINDOW) {
                            let _ = window.destroy();
                        }
                    }
                });
            }
        });
        answered
    }
}

/// Opens the question's window, or has the one open ask again.
#[cfg(unix)]
fn show_question(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.eval("location.reload()");
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("agent.html".into()))
        .title("Dozo")
        .inner_size(460.0, 300.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .always_on_top(true)
        .center()
        // Only its own page loads here.
        .on_navigation(crate::server::is_local)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    match built {
        Ok(window) => {
            #[cfg(not(target_os = "macos"))]
            let _ = window.remove_menu();
            let app = app.clone();
            // Closing the window without answering refuses.
            window.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    app.state::<AgentQuestion>().answer(false);
                }
            });
            let _ = window.set_focus();
        }
        // No window: the question cannot be answered, which refuses.
        Err(error) => {
            eprintln!("dozo: could not open the question: {error}");
            app.state::<AgentQuestion>().answer(false);
        }
    }
}

/// What the window shows: the text, and the words of its buttons in the system's language.
fn question_words(question: &str) -> Value {
    json!({
        "lang": if crate::words::turkish() { "tr" } else { "en" },
        "question": question,
        "allow": text("Allow"),
        "cancel": text("Cancel"),
    })
}

#[tauri::command]
pub fn agent_question(question: State<'_, AgentQuestion>) -> Option<Value> {
    question.words().map(|words| question_words(&words))
}

/// The person's answer; the window closes with it.
#[tauri::command]
pub fn agent_answer(window: WebviewWindow, question: State<'_, AgentQuestion>, allow: bool) {
    question.answer(allow);
    let _ = window.close();
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::Value;
    use tokio::sync::oneshot;

    use super::*;

    const FIVE: Duration = Duration::from_secs(5);

    #[test]
    fn cancel_comes_first_and_has_the_focus_so_enter_never_allows() {
        let page = include_str!("../ui/agent.html");
        let cancel = page.find(r#"id="cancel""#).unwrap();
        let allow = page.find(r#"id="allow""#).unwrap();
        assert!(cancel < allow);
        assert!(page[..allow].contains("autofocus"));
        let button = &page[page[..allow].rfind("<button").unwrap()..allow];
        assert!(!button.contains("autofocus"), "{button}");
        let script = include_str!("../ui/agent.js");
        assert!(script.contains(r#"el("cancel").focus()"#));
        assert!(script.contains("Escape"));
        // Escape and Enter on Cancel both refuse; a click on Allow alone allows.
        assert_eq!(script.matches("answer(true)").count(), 1);
    }

    #[test]
    fn the_text_is_shown_as_text_never_as_markup() {
        let script = include_str!("../ui/agent.js");
        assert!(script.contains("textContent"));
        for markup in [
            "innerHTML",
            "outerHTML",
            "insertAdjacentHTML",
            "document.write",
        ] {
            assert!(!script.contains(markup), "{markup}");
        }
    }

    #[test]
    fn only_the_questions_own_window_may_call_its_commands() {
        let own: Value = serde_json::from_str(include_str!("../capabilities/agent.json")).unwrap();
        assert_eq!(own["windows"], serde_json::json!(["agent"]));
        assert!(own.get("remote").is_none());
        assert_eq!(
            own["permissions"],
            serde_json::json!(["allow-agent-question", "allow-agent-answer"])
        );
        for other in [
            include_str!("../capabilities/local.json"),
            include_str!("../capabilities/fill.json"),
            include_str!("../capabilities/prefs.json"),
            include_str!("../capabilities/phone.json"),
            include_str!("../capabilities/backup.json"),
        ] {
            assert!(!other.contains("agent-question") && !other.contains("agent-answer"));
        }
        let build = include_str!("../build.rs");
        assert!(build.contains("\"agent_question\"") && build.contains("\"agent_answer\""));
    }

    #[tokio::test]
    async fn the_windows_answer_reaches_whoever_asked() {
        for allow in [true, false] {
            let question = AgentQuestion::default();
            let (asked, answered) = oneshot::channel();
            let (_, page) = question.put("Run ls?");
            let relaying = tokio::spawn(crate::passwords_ui::relay(asked, page));
            assert_eq!(question.words().as_deref(), Some("Run ls?"));
            question.answer(allow);
            question.answer(!allow);
            assert_eq!(
                tokio::time::timeout(FIVE, answered).await.unwrap(),
                Ok(allow)
            );
            relaying.await.unwrap();
            assert_eq!(question.words(), None);
        }
    }

    #[tokio::test]
    async fn a_window_that_goes_without_an_answer_is_a_refusal() {
        let question = AgentQuestion::default();
        let (asked, answered) = oneshot::channel();
        let (_, page) = question.put("Run ls?");
        tokio::spawn(crate::passwords_ui::relay(asked, page));
        question.put("Run pwd?");
        assert_eq!(
            tokio::time::timeout(FIVE, answered).await.unwrap(),
            Ok(false)
        );
    }

    #[tokio::test]
    async fn the_question_ends_when_nobody_waits_for_the_answer_any_more() {
        let question = AgentQuestion::default();
        let (asked, answered) = oneshot::channel();
        let (id, page) = question.put("Run ls?");
        let relaying = tokio::spawn(crate::passwords_ui::relay(asked, page));
        // The time ran out: the asker dropped its receiver, and the window goes with it.
        drop(answered);
        tokio::time::timeout(FIVE, relaying).await.unwrap().unwrap();
        let (_, _later) = question.put("Run pwd?");
        assert!(!question.end(id));
        let (current, _page) = question.put("Run pwd?");
        assert!(question.end(current));
        assert_eq!(question.words(), None);
    }

    #[test]
    fn the_window_shows_the_text_and_the_buttons_in_the_systems_language() {
        let shown = question_words("Run ls?");
        assert_eq!(shown["question"], "Run ls?");
        assert_eq!(shown["allow"], crate::words::text("Allow"));
        assert_eq!(shown["cancel"], crate::words::text("Cancel"));
        assert!(["en", "tr"].contains(&shown["lang"].as_str().unwrap()));
    }
}
