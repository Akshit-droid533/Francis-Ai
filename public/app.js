const messagesElement = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const promptInput = document.getElementById("prompt");
const sendButton = document.getElementById("send-button");
const sendLabel = document.getElementById("send-label");
const errorBox = document.getElementById("error-box");

const adminOpen = document.getElementById("admin-open");
const adminClose = document.getElementById("admin-close");
const adminPanel = document.getElementById("admin-panel");
const adminForm = document.getElementById("admin-form");
const adminPassword = document.getElementById("admin-password");
const adminStatus = document.getElementById("admin-status");
const adminLogout = document.getElementById("admin-logout");

const clearButton = document.getElementById("clear-chat");

let conversation = [];
let busy = false;
let adminToken = null;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function hideError() {
  errorBox.textContent = "";
  errorBox.hidden = true;
}

function addMessage(role, content) {
  const article = document.createElement("article");

  article.className =
    role === "user"
      ? "message user-message"
      : "message assistant-message";

  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "YOU" : "FRANCIS";

  const body = document.createElement("div");
  body.className = "message-content";

  // Use textContent to avoid treating AI output as HTML.
  body.textContent = content;

  article.appendChild(label);
  article.appendChild(body);

  messagesElement.appendChild(article);

  messagesElement.scrollTop = messagesElement.scrollHeight;

  return body;
}

function setBusy(value) {
  busy = value;

  sendButton.disabled = value;
  promptInput.disabled = value;

  sendLabel.textContent = value ? "THINKING..." : "SEND ↗";
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (busy) {
    return;
  }

  const text = promptInput.value.trim();

  if (!text) {
    return;
  }

  hideError();

  conversation.push({
    role: "user",
    content: text
  });

  addMessage("user", text);

  promptInput.value = "";

  // Keep the request within the backend's message limit.
  if (conversation.length > 20) {
    conversation = conversation.slice(-20);
  }

  setBusy(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: conversation
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "The request failed."
      );
    }

    if (typeof data.answer !== "string") {
      throw new Error("The AI returned an invalid response.");
    }

    conversation.push({
      role: "assistant",
      content: data.answer
    });

    if (conversation.length > 20) {
      conversation = conversation.slice(-20);
    }

    addMessage("assistant", data.answer);

  } catch (error) {
    showError(error.message || "Something went wrong.");
  } finally {
    setBusy(false);
    promptInput.focus();
  }
});

clearButton.addEventListener("click", () => {
  if (busy) {
    return;
  }

  conversation = [];
  messagesElement.replaceChildren();
  hideError();

  addMessage(
    "assistant",
    "Conversation cleared. What would you like to explore next?"
  );
});

promptInput.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

// Admin panel controls.
adminOpen.addEventListener("click", () => {
  adminPanel.hidden = false;

  adminPanel.scrollIntoView({
    behavior: "smooth",
    block: "center"
  });
});

adminClose.addEventListener("click", () => {
  adminPanel.hidden = true;
});

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  adminStatus.textContent = "Checking credentials...";

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        password: adminPassword.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Admin login failed."
      );
    }

    adminToken = data.token;

    adminPassword.value = "";

    adminStatus.textContent =
      "Admin authentication successful. Session expires in two hours.";

    adminLogout.hidden = false;

  } catch (error) {
    adminStatus.textContent =
      error.message || "Unable to log in.";
  }
});

adminLogout.addEventListener("click", async () => {
  try {
    if (adminToken) {
      await fetch("/api/admin/logout", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${adminToken}`
        }
      });
    }
  } finally {
    adminToken = null;
    adminLogout.hidden = true;
    adminStatus.textContent = "Logged out.";
  }
});
