# Fortivo CRM

Fortivo CRM is a lightweight web‑based customer relationship management (CRM)
application built with Python.  It runs without external dependencies
by leveraging Python’s built‑in web server and Jinja2 for templating.  The
application stores data in a local SQLite database and exposes both a
human‑friendly web interface and a RESTful API for integration.

## Features

* **Dashboard:** View total clients, active clients, leads and overdue
  follow‑ups at a glance.  A pie chart visualises the distribution of
  client statuses using Chart.js.
* **Client Management:** Add, view, edit and delete clients.  Clients
  have fields for name, email, phone, status, follow‑up date and notes.
* **Filtering & Search:** Quickly find clients by name or email and
  filter by status.  Sort the list by name, email, status or follow‑up
  date in ascending or descending order.
* **Overdue Highlighting:** Clients with follow‑up dates prior to the
  current date are highlighted in red on the list.
* **CSV Export:** Download the full client list as a CSV file for use in
  spreadsheets or external systems.
* **RESTful API:** Programmatically access and manipulate client
  records via JSON over HTTP.  Endpoints support listing, retrieving,
  creating, updating and deleting clients.

## Getting Started

### Prerequisites

Python 3.11 is included in this environment.  No external Python
packages are required because the application uses only the standard
library and Jinja2 (already installed).  If you run this outside of
the provided environment, ensure that `jinja2` is installed:

```bash
pip install jinja2
```

### Installation

1. Clone or download this repository.
2. Navigate into the project directory:

   ```bash
   cd fortivo_crm
   ```
3. (Optional) Create a Python virtual environment.
4. Run the application:

   ```bash
   python app.py
   ```

   The server will start on `http://localhost:5000`.  Visit
   `/dashboard` in your browser to access the dashboard (note: in some
   browser sandboxes, access to `localhost` might be restricted).

### Usage

* Navigate to **Dashboard** for an overview of KPIs and status
  distribution.
* Click **Clients** to view the list.  Use the search box and filter
  drop‑downs to narrow results.  Click **Edit** or **Delete** to
  modify a record.  Click **Add Client** to create a new entry.
* Download a CSV export by clicking **Export CSV** on the clients page.

### API

The application exposes a simple JSON API under the `/api/clients`
prefix.  Examples:

| Method & URL                     | Description                       |
|---------------------------------|-----------------------------------|
| `GET /api/clients`              | List all clients                  |
| `POST /api/clients`             | Create a new client (JSON body)   |
| `GET /api/clients/<id>`         | Retrieve a single client          |
| `PUT/PATCH /api/clients/<id>`   | Update an existing client (JSON)  |
| `DELETE /api/clients/<id>`      | Delete a client                   |

When creating or updating via API, send a JSON body containing the
fields: `name`, `email`, `phone`, `status`, `follow_up_date` (ISO
`YYYY-MM-DD`) and `notes`.  Only `name` and `email` are required.

### Outlook Integration (Future)

While this initial version does not create calendar events or send
emails, the architecture is designed for easy extension.  You could
adapt the API endpoints or add hooks to call Outlook services using
Microsoft Graph or other connectors when clients are added or follow‑up
dates are updated.

## Extending

* **User Authentication:** The application currently has no login
  mechanism.  You can integrate a simple username/password system or
  OAuth provider to secure access.
* **Database Backend:** Switch to PostgreSQL or another database by
  replacing the SQLite connection logic in `app.py`.
* **Front‑end Framework:** Replace the server‑side rendered templates
  with a modern front‑end like React or Vue.js.  The API endpoints
  provided here can serve as the backend for such a client.

## License

This project is provided for demonstration purposes and carries no
specific licence.  Adapt and use as needed.