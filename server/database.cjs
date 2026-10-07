const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

// Keep persistent data outside the source tree in production so a mounted disk can be used.
const dataDir = process.env.DATA_DIR || __dirname
fs.mkdirSync(dataDir, { recursive: true })
const db = new Database(path.join(dataDir, 'careerready.db'))
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
db.pragma('synchronous = NORMAL') // safe with WAL, noticeably faster writes

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'Other',
    year TEXT NOT NULL DEFAULT '1st year',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    text TEXT NOT NULL,
    options TEXT NOT NULL,
    answer INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    taken_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS internships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT NOT NULL,
    branch TEXT NOT NULL,
    mode TEXT NOT NULL,
    stipend TEXT NOT NULL,
    deadline TEXT NOT NULL,
    skills TEXT NOT NULL,
    description TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved (
    user_id INTEGER NOT NULL,
    internship_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, internship_id)
  );

  -- Career roles and their step-by-step roadmaps
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    branch TEXT NOT NULL,
    summary TEXT NOT NULL,
    weights TEXT NOT NULL,   -- JSON [programming, aptitude, communication], adds up to 100
    keywords TEXT NOT NULL   -- comma separated, used to match live job listings
  );

  CREATE TABLE IF NOT EXISTS roadmap_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id INTEGER NOT NULL,
    step_order INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    resource_name TEXT NOT NULL,
    resource_url TEXT NOT NULL,
    FOREIGN KEY (role_id) REFERENCES roles(id)
  );

  CREATE TABLE IF NOT EXISTS user_goals (
    user_id INTEGER PRIMARY KEY,
    role_id INTEGER NOT NULL,
    chosen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_progress (
    user_id INTEGER NOT NULL,
    step_id INTEGER NOT NULL,
    done_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, step_id)
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    internship_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'Interested',
    notes TEXT NOT NULL DEFAULT '',
    applied_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, internship_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (internship_id) REFERENCES internships(id)
  );

  -- Jobs collected from free public job feeds
  CREATE TABLE IF NOT EXISTS live_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ext_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT NOT NULL,
    remote INTEGER NOT NULL DEFAULT 0,
    url TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resumes (
    user_id INTEGER PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS mentor_profiles (user_id INTEGER PRIMARY KEY, headline TEXT NOT NULL DEFAULT '', expertise TEXT NOT NULL DEFAULT '', experience_years INTEGER NOT NULL DEFAULT 0, company TEXT NOT NULL DEFAULT '', linkedin TEXT NOT NULL DEFAULT '', hourly_rate INTEGER NOT NULL DEFAULT 0, availability TEXT NOT NULL DEFAULT 'Flexible', verification_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS mentor_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, mentor_id INTEGER NOT NULL, student_id INTEGER NOT NULL, message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(mentor_id, student_id));
  CREATE TABLE IF NOT EXISTS mentor_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, mentor_id INTEGER NOT NULL, student_id INTEGER NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, meeting_url TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'scheduled', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS mentor_evaluations (id INTEGER PRIMARY KEY AUTOINCREMENT, mentor_id INTEGER NOT NULL, student_id INTEGER NOT NULL, session_id INTEGER, category TEXT NOT NULL, score INTEGER NOT NULL, strengths TEXT NOT NULL DEFAULT '', improvements TEXT NOT NULL DEFAULT '', action_plan TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS mentor_resources (id INTEGER PRIMARY KEY AUTOINCREMENT, mentor_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS mentor_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, mentor_id INTEGER NOT NULL, student_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', due_date TEXT, status TEXT NOT NULL DEFAULT 'assigned', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS community_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, category TEXT NOT NULL DEFAULT 'General', title TEXT NOT NULL, body TEXT NOT NULL, likes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS community_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS community_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, reporter_id INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`)

// ---------- Sample questions (added once) ----------
const questions = [
  ['Programming', 'What is the time complexity of binary search on a sorted array?', ['O(n)', 'O(log n)', 'O(n log n)', 'O(1)'], 1],
  ['Programming', 'Which data structure follows the FIFO (first in, first out) rule?', ['Queue', 'Stack', 'Tree', 'Graph'], 0],
  ['Programming', 'In SQL, which clause filters rows before they are grouped?', ['HAVING', 'ORDER BY', 'WHERE', 'LIMIT'], 2],
  ['Programming', 'What does === do in JavaScript?', ['Assigns a value', 'Compares only the value', 'Declares a constant', 'Compares value and type'], 3],

  ['Aptitude', 'If 20% of a number is 45, what is the number?', ['180', '225', '250', '90'], 1],
  ['Aptitude', 'What comes next in the series 2, 6, 12, 20, 30, ...?', ['40', '44', '42', '36'], 2],
  ['Aptitude', 'A train travels at 60 km/h. How long does it take to cover 150 km?', ['2 hours', '2.5 hours', '3 hours', '3.5 hours'], 1],
  ['Aptitude', 'What is the average of 10, 20, 30, 40 and 50?', ['20', '25', '30', '35'], 2],

  ['Communication', 'How should you begin a professional email to someone you have not met?', ['Hey buddy,', 'Dear Ms./Mr. Surname,', 'No greeting, just the request', 'Hi!!!'], 1],
  ['Communication', 'An interviewer asks about your weakness. What is the best approach?', ['Say you have none', 'Blame a previous team', 'Share a real one and how you are improving it', 'Change the topic'], 2],
  ['Communication', 'What does active listening mean?', ['Planning your reply while they talk', 'Focusing fully and confirming you understood', 'Interrupting to correct mistakes', 'Checking your phone now and then'], 1],
  ['Communication', 'What is the ideal length of a fresher resume?', ['One focused page with projects and skills', 'Five pages with every detail', 'Only a photo and a name', 'Only hobbies'], 0],
]

if (db.prepare('SELECT COUNT(*) AS n FROM questions').get().n === 0) {
  const insert = db.prepare('INSERT INTO questions (category, text, options, answer) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    for (const q of questions) insert.run(q[0], q[1], JSON.stringify(q[2]), q[3])
  })()
}

// ---------- Sample internships (added once) ----------
// These are sample records for the college project. Company names are made up.
const internships = [
  ['Software Developer Intern', 'BrightLoop Technologies', 'Hyderabad', 'CSE', 'Hybrid', 'Rs. 15,000 / month', '2026-11-20', 'JavaScript, React, Node.js', 'Build and test features for a web dashboard used by small businesses.'],
  ['Data Analyst Intern', 'Northwind Analytics', 'Bengaluru', 'CSE', 'Remote', 'Rs. 12,000 / month', '2026-11-15', 'Python, SQL, Excel', 'Clean datasets, write SQL queries and create weekly reports.'],
  ['Embedded Systems Intern', 'Kestrel Devices', 'Pune', 'ECE', 'On-site', 'Rs. 10,000 / month', '2026-12-01', 'C, Microcontrollers, Circuit design', 'Help program and test microcontroller boards for smart meters.'],
  ['VLSI Design Trainee', 'SiliconNest Labs', 'Hyderabad', 'ECE', 'On-site', 'Rs. 14,000 / month', '2026-11-30', 'Verilog, Digital design', 'Write and verify small RTL blocks under a senior engineer.'],
  ['Power Systems Intern', 'GridWorks Energy', 'Chennai', 'EEE', 'On-site', 'Rs. 9,000 / month', '2026-12-10', 'MATLAB, Power systems, AutoCAD', 'Assist with load studies and substation drawings.'],
  ['Mechanical Design Intern', 'Ironleaf Engineering', 'Coimbatore', 'Mechanical', 'On-site', 'Rs. 8,000 / month', '2026-11-25', 'SolidWorks, GD&T, Manufacturing', 'Prepare CAD models and drawings for machined components.'],
  ['Site Engineer Intern', 'Stonebridge Constructions', 'Vijayawada', 'Civil', 'On-site', 'Rs. 8,000 / month', '2026-12-05', 'AutoCAD, Surveying, Estimation', 'Support site supervision, quantity estimation and daily reports.'],
  ['Cloud Support Intern', 'Skyforge Systems', 'Remote', 'All', 'Remote', 'Rs. 10,000 / month', '2026-11-18', 'Linux, Networking, Git', 'Handle basic support tickets and learn cloud deployment basics.'],
  ['Technical Content Intern', 'CodeCraft Learning', 'Remote', 'All', 'Remote', 'Rs. 6,000 / month', '2026-12-15', 'Technical writing, Communication', 'Write beginner-friendly tutorials and review student projects.'],
  ['UI Developer Intern', 'PixelHarbor Studio', 'Hyderabad', 'CSE', 'Hybrid', 'Rs. 12,000 / month', '2026-12-08', 'HTML, CSS, React', 'Turn design mockups into responsive React components.'],
]

if (db.prepare('SELECT COUNT(*) AS n FROM internships').get().n === 0) {
  const insert = db.prepare(
    'INSERT INTO internships (title, company, location, branch, mode, stipend, deadline, skills, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  db.transaction(() => {
    for (const i of internships) insert.run(...i)
  })()
}

// ---------- Career roles and roadmaps (added once) ----------
// weights = how much [Programming, Aptitude, Communication] matter for the role
// each step = [title, what to do, resource name, free resource link]
const roles = [
  {
    slug: 'frontend', title: 'Frontend Developer', branch: 'CSE', weights: [55, 15, 30],
    keywords: 'frontend,front-end,react,ui developer',
    summary: 'Build the screens people see and use in websites and apps.',
    steps: [
      ['Learn HTML, CSS and JavaScript', 'Build 3 small pages: a profile, a landing page and a to-do app.', 'freeCodeCamp', 'https://www.freecodecamp.org'],
      ['Go deeper into JavaScript', 'Practise ES6, async/await, fetch and the DOM until you can build without copying.', 'MDN Web Docs', 'https://developer.mozilla.org'],
      ['Learn React', 'Components, props, state and hooks. Rebuild your to-do app in React.', 'roadmap.sh Frontend', 'https://roadmap.sh/frontend'],
      ['Use Git and GitHub', 'Push every project to GitHub with a short README.', 'GitHub Skills', 'https://skills.github.com'],
      ['Deploy 2 projects and apply', 'Put your projects online for free, add the links to your resume and apply.', 'Vercel', 'https://vercel.com'],
    ],
  },
  {
    slug: 'backend', title: 'Backend Developer', branch: 'CSE', weights: [60, 20, 20],
    keywords: 'backend,back-end,node.js,python developer,java developer',
    summary: 'Build the servers, databases and APIs that power applications.',
    steps: [
      ['Pick one language', 'Choose Python or JavaScript and finish one full beginner course.', 'freeCodeCamp', 'https://www.freecodecamp.org'],
      ['Learn SQL and databases', 'Practise SELECT, JOIN, GROUP BY and designing tables.', 'SQLBolt', 'https://sqlbolt.com'],
      ['Build REST APIs', 'Make an API with login, CRUD routes and validation.', 'roadmap.sh Backend', 'https://roadmap.sh/backend'],
      ['Practise data structures', 'Solve arrays, strings, stacks, queues and hash map problems.', 'GeeksforGeeks', 'https://www.geeksforgeeks.org'],
      ['Ship a capstone', 'Deploy an app with authentication and a database, and put it on GitHub.', 'GitHub Skills', 'https://skills.github.com'],
    ],
  },
  {
    slug: 'data-analyst', title: 'Data Analyst', branch: 'CSE', weights: [40, 40, 20],
    keywords: 'data analyst,data analysis,analytics,business intelligence',
    summary: 'Turn raw data into answers and charts that help teams decide.',
    steps: [
      ['Learn statistics basics', 'Mean, median, variance, probability and sampling.', 'Khan Academy', 'https://www.khanacademy.org'],
      ['Learn SQL', 'Write queries to filter, join and summarise data.', 'SQLBolt', 'https://sqlbolt.com'],
      ['Learn Python for data', 'Use pandas to clean data and make charts.', 'Kaggle Learn', 'https://www.kaggle.com/learn'],
      ['Follow the analyst roadmap', 'Add dashboards and storytelling with data.', 'roadmap.sh Data Analyst', 'https://roadmap.sh/data-analyst'],
      ['Build 3 portfolio analyses', 'Analyse public datasets and write a short report for each.', 'Kaggle Datasets', 'https://www.kaggle.com/datasets'],
    ],
  },
  {
    slug: 'cloud-devops', title: 'Cloud / DevOps Support Engineer', branch: 'All', weights: [40, 30, 30],
    keywords: 'devops,cloud engineer,sre,support engineer,linux',
    summary: 'Keep applications running by managing servers, deployments and monitoring.',
    steps: [
      ['Learn Linux basics', 'Files, permissions, processes and shell commands.', 'Linux Journey', 'https://linuxjourney.com'],
      ['Understand networking', 'IP, DNS, HTTP and ports.', 'roadmap.sh DevOps', 'https://roadmap.sh/devops'],
      ['Learn Git and CI basics', 'Branches, pull requests and an automated test run.', 'GitHub Skills', 'https://skills.github.com'],
      ['Learn Docker', 'Containerise one of your own projects.', 'Docker Docs', 'https://docs.docker.com/get-started/'],
      ['Deploy something', 'Run a project on a free cloud tier and write down the steps.', 'roadmap.sh DevOps', 'https://roadmap.sh/devops'],
    ],
  },
  {
    slug: 'embedded', title: 'Embedded Systems Engineer', branch: 'ECE', weights: [45, 30, 25],
    keywords: 'embedded,firmware,iot,microcontroller',
    summary: 'Write software that runs inside devices like meters, sensors and appliances.',
    steps: [
      ['Learn C programming', 'Pointers, arrays, structs and bitwise operations.', 'Learn-C.org', 'https://www.learn-c.org'],
      ['Revise digital electronics', 'Logic gates, flip-flops and number systems.', 'NPTEL', 'https://nptel.ac.in'],
      ['Build Arduino projects', 'Read a sensor, show it on a display and log it.', 'Arduino Docs', 'https://docs.arduino.cc'],
      ['Learn UART, I2C and SPI', 'Connect two devices and exchange data.', 'SparkFun Learn', 'https://learn.sparkfun.com'],
      ['Finish a mini project', 'Build a complete device, photograph it and document it on GitHub.', 'GitHub Skills', 'https://skills.github.com'],
    ],
  },
  {
    slug: 'vlsi', title: 'VLSI / Digital Design Engineer', branch: 'ECE', weights: [40, 40, 20],
    keywords: 'vlsi,verilog,rtl,asic,fpga',
    summary: 'Design the digital circuits inside chips.',
    steps: [
      ['Master digital logic', 'Combinational and sequential circuits, FSMs and timing.', 'NPTEL', 'https://nptel.ac.in'],
      ['Practise Verilog', 'Solve small design problems until the basics feel easy.', 'HDLBits', 'https://hdlbits.01xz.net'],
      ['Study CMOS and VLSI design', 'Take one full course on CMOS circuits and design flow.', 'SWAYAM', 'https://swayam.gov.in'],
      ['Simulate your designs', 'Write a testbench and run it in an online simulator.', 'EDA Playground', 'https://www.edaplayground.com'],
      ['Build an FPGA-style mini project', 'Design a counter, UART or small ALU and document it.', 'Nandland', 'https://nandland.com'],
    ],
  },
  {
    slug: 'power-systems', title: 'Power Systems Engineer', branch: 'EEE', weights: [35, 45, 20],
    keywords: 'power systems,electrical engineer,substation,solar',
    summary: 'Plan and maintain how electricity is generated, moved and used.',
    steps: [
      ['Revise circuits and machines', 'Network theorems, transformers and motors.', 'NPTEL', 'https://nptel.ac.in'],
      ['Study power system analysis', 'Load flow, fault analysis and protection basics.', 'SWAYAM', 'https://swayam.gov.in'],
      ['Learn MATLAB and Simulink', 'Simulate a simple power circuit.', 'MATLAB Academy', 'https://matlabacademy.mathworks.com'],
      ['Learn electrical drawing', 'Read and make single-line diagrams in CAD.', 'Autodesk Education', 'https://www.autodesk.com/education/edu-software/overview'],
      ['Do an internship or site visit', 'Visit a substation or solar plant and write a short report.', 'NPTEL', 'https://nptel.ac.in'],
    ],
  },
  {
    slug: 'mechanical-design', title: 'Mechanical Design Engineer', branch: 'Mechanical', weights: [30, 45, 25],
    keywords: 'mechanical engineer,cad designer,design engineer,solidworks',
    summary: 'Design parts and machines, then prepare the drawings to make them.',
    steps: [
      ['Learn engineering drawing and GD&T', 'Read drawings, tolerances and fits.', 'NPTEL', 'https://nptel.ac.in'],
      ['Learn a CAD tool', 'Model 5 parts and an assembly using free software.', 'FreeCAD', 'https://www.freecad.org'],
      ['Study machine design', 'Strength of materials, shafts, gears and bearings.', 'SWAYAM', 'https://swayam.gov.in'],
      ['Understand manufacturing', 'Casting, machining, welding and sheet metal.', 'NPTEL', 'https://nptel.ac.in'],
      ['Finish a design project', 'Design a small mechanism with a full drawing set and a short report.', 'FreeCAD', 'https://www.freecad.org'],
    ],
  },
  {
    slug: 'site-engineer', title: 'Civil / Site Engineer', branch: 'Civil', weights: [25, 50, 25],
    keywords: 'civil engineer,site engineer,construction,structural',
    summary: 'Plan, supervise and check construction work on site.',
    steps: [
      ['Learn surveying and materials', 'Levelling, chain surveying and concrete basics.', 'NPTEL', 'https://nptel.ac.in'],
      ['Learn AutoCAD drawings', 'Read plans and draw a simple floor plan.', 'Autodesk Education', 'https://www.autodesk.com/education/edu-software/overview'],
      ['Study structural analysis', 'Beams, frames and load calculation basics.', 'SWAYAM', 'https://swayam.gov.in'],
      ['Learn estimation and costing', 'Prepare a quantity estimate for a small building.', 'NPTEL', 'https://nptel.ac.in'],
      ['Visit a live site', 'Spend time on a site, write a daily report and ask an engineer for feedback.', 'NPTEL', 'https://nptel.ac.in'],
    ],
  },
]

if (db.prepare('SELECT COUNT(*) AS n FROM roles').get().n === 0) {
  const insertRole = db.prepare('INSERT INTO roles (slug, title, branch, summary, weights, keywords) VALUES (?, ?, ?, ?, ?, ?)')
  const insertStep = db.prepare(
    'INSERT INTO roadmap_steps (role_id, step_order, title, description, resource_name, resource_url) VALUES (?, ?, ?, ?, ?, ?)'
  )
  db.transaction(() => {
    for (const r of roles) {
      const info = insertRole.run(r.slug, r.title, r.branch, r.summary, JSON.stringify(r.weights), r.keywords)
      r.steps.forEach((s, index) => insertStep.run(info.lastInsertRowid, index + 1, s[0], s[1], s[2], s[3]))
    }
  })()
}

module.exports = db
