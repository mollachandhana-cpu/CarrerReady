
🎓 CareerReady

CareerReady is a modern, full-stack web application designed to bridge the gap between aspiring professionals and industry experts. The platform empowers users through structured mentorship pipelines, peer-to-peer community interactions, and AI-driven career development workflows.

🚀 Key Features

• 👨‍🏫 MentorHub: A dedicated space for students and professionals to discover, connect, and schedule guidance sessions with industry mentors.
• 👥 Community Portal: An interactive forum for users to network, share resources, discuss career paths, and collaborate on projects.
• 🤖 AI-Powered Insights: Integrated smart features providing automated career path recommendations and resume optimization tips.
• 🔐 Secure Authentication: Complete JWT-based registration and secure login framework for both standard users and mentors.
• 🛡️ Administrative Controls: Built-in command utilities to easily manage infrastructure and promote system administrators.

🏗️ Project Architecture

The application is structured as a decoupled monorepo containing a high-performance Vite + React frontend and a scalable Node.js backend.
text
careerready_final/
├── 📁 public/                 # Static visual assets & global vector icons
├── 📁 src/                    # Frontend React Application
│   ├── 📁 assets/             # Images, SVGs, and brand illustrations
│   ├── 📄 App.jsx             # Core client router and application shell
│   ├── 📄 MentorHub.jsx       # Mentor discovery and pairing interface
│   ├── 📄 Community.jsx      # Social networking and forum dashboard
│   ├── 📄 Login.jsx / Signup  # Authentication user flows
│   └── 📄 api.js              # Centralized Axios HTTP client configuration
├── 📁 server/                 # Backend Node.js Environment
│   ├── 📄 server.js           # Express framework entry point & middleware
│   ├── 📄 database.js         # Relational database driver initialization
│   ├── 📄 ai.js               # Artificial Intelligence engine integrations
│   └── 📄 promote-admin.js    # Data management script for admin provisioning
├── 📄 Dockerfile              # Containerization orchestration blueprint
├── 📄 render.yaml             # Automated Infrastructure-as-Code deployment spec
└── 📁 .github/workflows/      # Automated CI/CD compilation suite
Use code with caution.

🛠️ Tech Stack

Component	Technologies Used
Frontend	React, Vite, CSS3 Variables, Axios, ESLint
Backend	Node.js, Express.js, Custom Middleware
Database	Structured Database Layer
AI Layer	Native Language Processing Core
DevOps & Cloud	Docker, Render Infrastructure, GitHub Actions (CI/CD)

💻 Local Setup Instructions


Prerequisites

• Node.js (v18.0.0 or higher recommended)
• Docker (Optional, for containerized local execution)

1. Clone & Install Dependencies

Navigate to the root directory and set up the package configurations:
bash
# Install core dependencies
npm install
Use code with caution.

2. Environment Configuration

Create an active environment file from the provided template inside the root directory and the server directory:
bash
cp .env.example .env
cp server/.env.example server/.env
Use code with caution.
💡 Make sure to open the .env files and populate your database URI, token keys, and AI system credentials.

3. Run the Backend Server

bash
cd server
npm install
npm run start  # Or native launch depending on your package scripts
Use code with caution.

4. Run the Client Application

Open a new terminal window at the root directory:
bash
npm run dev
Use code with caution.
Your client application will now be securely running locally on http://localhost:5173!

🚢 Continuous Integration & Cloud Deployment


Containerization

The project includes a production-ready Dockerfile and .dockerignore array, allowing you to wrap the build into an isolated image instantly:
bash
docker build -t careerready-app .
Use code with caution.

Automatic Cloud Provisioning

• Render: The native render.yaml configuration automates deployments directly to the cloud upon code check-ins.
• GitHub Actions: The ci.yml pipeline automatically performs linting checkups and regression tests on every push or pull request to ensure high code quality.
