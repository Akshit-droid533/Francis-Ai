# FRANCIS AI

FRANCIS AI is a self-hosted coding-agent starter project. It provides a web workspace, password-protected access, AI tool-calling, project files, Docker-isolated command execution, test-running workflows, and ZIP downloads.

## What is included

- Responsive Matrix-green frontend
- Password login for a single private administrator
- AI agent that can list/read/write project files and run commands
- Short-lived Docker sandbox containers with no network, dropped Linux capabilities, memory/CPU/PID limits, read-only root filesystem, and a writable project mount
- Manual command runner
- File editor and ZIP export
- Project folders stored under `data/projects`

## Requirements

- Node.js 20 or newer
- Docker Engine running on the host
- An OpenRouter API key and a model that supports tool/function calling
- A computer/server where you can install and operate Docker

## Setup

1. Copy `.env.example` to `.env`.
2. Set `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, and a long unique `ADMIN_PASSWORD`. The base URL should be `https://openrouter.ai/api/v1`.
3. In the project folder, build the sandbox image:
   `docker build -t francis-ai-sandbox:latest ./sandbox`
4. Install Node dependencies:
   `npm install`
5. Start the server:
   `npm start`
6. Open `http://localhost:3000` and sign in using `ADMIN_PASSWORD`.

If you deploy the web server in a container, it needs access to the Docker socket to create sandbox containers. The included Compose file mounts the socket; this is a highly privileged capability. Prefer running the app on a dedicated VM and never share that Docker host with sensitive workloads.

## AI provider configuration

The server calls `${OPENROUTER_BASE_URL}/chat/completions` and uses tool calling. Create a key at https://openrouter.ai/keys and choose a model that supports tool/function calling from https://openrouter.ai/models. The default model is `openai/gpt-4.1-mini`; if unavailable to your account, select another compatible model and change `OPENROUTER_MODEL`. Keep the key in server-side environment variables only; never put it in `public/` or client JavaScript. You can also set `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, and `OPENROUTER_MODEL` in Render's Environment tab.

## Safety model and limitations

- Code runs in a separate Docker container with `NetworkMode: none`, non-root user, read-only root filesystem, dropped capabilities, and resource limits.
- The sandbox image is deliberately small. It includes Python, Node.js, npm, Bash, and Git, but network access is disabled, so package installs that need the internet will fail.
- The agent can run commands in a project directory. Treat generated code as untrusted and inspect it before deploying or running it outside the sandbox.
- The app uses a single administrator password and in-memory sessions. It is a private starter, **not a production multi-user service**. Restarting the server invalidates sessions. Add a database, per-user authorization, persistent session storage, HTTPS, backups, CSRF protections as appropriate, and monitoring before public multi-user launch.
- The Docker socket is effectively host-level authority. Keep this on a dedicated server, do not expose the socket to the internet, and restrict who can log in.
- This starter does not provide a model or API credits. The AI provider may charge for requests.
- Commands have a maximum execution time; the agent has a configurable tool-step limit.

## Troubleshooting

- **AI is not configured:** set `OPENROUTER_API_KEY` in `.env` (or your host environment) and restart.
- **Sandbox image missing:** run the sandbox image build step above.
- **Docker permission error:** make sure the Node process can access the Docker daemon. Do not solve this by exposing Docker's TCP port publicly.
- **Provider tool-call error:** check that the selected OpenRouter model supports Chat Completions tool calling and that `OPENROUTER_BASE_URL` is `https://openrouter.ai/api/v1`.
- **Port conflict:** set another `PORT` value in `.env`.

## Deployment

Deploy to a VM or host that supports Docker and persistent storage. GitHub Pages alone cannot run this backend or execute commands. For public access, put it behind HTTPS and a reverse proxy, use strong credentials, keep the OS and Docker updated, and apply additional rate limits and access controls.

## License

MIT
