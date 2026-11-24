//! The one question a small window of the app's own has on screen (`passwords_ui.rs`, the login
//! question, and `agent_ui.rs`, an agent's question): what it shows, its id, where its answer
//! goes, and what the window going away does. Both windows share this, so a fix here is a fix
//! for both.
//!
//! Every question has an id (from 1; a window with nothing shown answers with 0, which is never
//! open) and an answer counts only for the question it names: a window that still shows an
//! earlier question can neither approve nor refuse a later one. A window that goes without an
//! answer refuses the question open, except the one destroyed on purpose for a question that had
//! already ended (`retire_window`).

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tokio::sync::oneshot;

pub struct Slot<D> {
    open: Mutex<Option<Open<D>>>,
    count: AtomicU64,
    /// A destroy asked for by `retire_window` has not been seen yet.
    retired: AtomicBool,
}

impl<D> Default for Slot<D> {
    fn default() -> Self {
        Slot {
            open: Mutex::new(None),
            count: AtomicU64::new(0),
            retired: AtomicBool::new(false),
        }
    }
}

struct Open<D> {
    id: u64,
    data: D,
    answer: oneshot::Sender<bool>,
}

impl<D: Clone> Slot<D> {
    /// Puts a question up, in place of any other (which is refused). Answers its id and where its
    /// answer comes from.
    pub fn put(&self, data: D) -> (u64, oneshot::Receiver<bool>) {
        let (answer, answered) = oneshot::channel();
        let id = self.count.fetch_add(1, Ordering::SeqCst) + 1;
        *self.open.lock().unwrap() = Some(Open { id, data, answer });
        (id, answered)
    }

    /// The question open, with its id.
    pub fn open(&self) -> Option<(u64, D)> {
        let open = self.open.lock().unwrap();
        open.as_ref().map(|open| (open.id, open.data.clone()))
    }

    /// The answer to question `id`, true when it was the one open. Only the first one counts.
    pub fn answer(&self, id: u64, allow: bool) -> bool {
        let mut open = self.open.lock().unwrap();
        if open.as_ref().is_some_and(|open| open.id == id) {
            let _ = open.take().unwrap().answer.send(allow);
            return true;
        }
        false
    }

    /// The window was destroyed: a refusal for the question open, unless this was the destroy
    /// `retire_window` asked for, which is for a question that already ended and must not take
    /// the next one with it.
    pub fn window_gone(&self) {
        let mut open = self.open.lock().unwrap();
        if self.retired.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(open) = open.take() {
            let _ = open.answer.send(false);
        }
    }

    /// The window of an ended question is about to be destroyed; false (keep it) when another
    /// question is open by now, which the window shows next.
    pub fn retire_window(&self) -> bool {
        let open = self.open.lock().unwrap();
        if open.is_some() {
            return false;
        }
        self.retired.store(true, Ordering::SeqCst);
        true
    }

    /// A new window is open: no destroy is waiting for an old one.
    pub fn window_opened(&self) {
        let _open = self.open.lock().unwrap();
        self.retired.store(false, Ordering::SeqCst);
    }

    /// The question `id` is over; true when it was the one on screen (its window should close).
    pub fn end(&self, id: u64) -> bool {
        let mut open = self.open.lock().unwrap();
        if open.as_ref().is_some_and(|open| open.id == id) {
            *open = None;
            return true;
        }
        false
    }
}
