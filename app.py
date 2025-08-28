"""
Fortivo CRM Application
=======================

This module implements a simple Customer Relationship Management (CRM) web
application tailored for the Fortivo use case.  It is intentionally
lightweight and uses only Python's built‑in libraries along with
Jinja2 for templating.  The absence of Flask in this environment means
we've constructed a minimal WSGI framework from scratch.  Despite the
simplicity, the application supports the following features:

  * Dashboard displaying key performance indicators (KPIs) and a pie chart
    of client statuses via Chart.js.
  * CRUD operations for clients: add, list, edit and delete.
  * Filtering, sorting and searching the client list.
  * RESTful API endpoints for programmatic access to client data.
  * CSV export of the entire client list.

The database is stored in a SQLite file located in the ``instance``
directory.  Each request opens a connection on demand to maintain
isolation between threads.  Jinja2 templates live in the ``templates``
folder and static assets (CSS and JavaScript) are served from
``static``.

To run the application locally execute this module directly.  By
default it listens on port 5000.  Adjust the host and port in the
``run()`` call at the bottom of this file as needed.
"""

import datetime
import io
import json
import os
import sqlite3
import csv
from urllib.parse import parse_qs, urlparse
from wsgiref.simple_server import make_server
from wsgiref.util import setup_testing_defaults

from jinja2 import Environment, FileSystemLoader, select_autoescape


# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

# Determine base directory for templates and database
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
DB_PATH = os.path.join(INSTANCE_DIR, "crm.sqlite")

# Ensure the instance directory exists
os.makedirs(INSTANCE_DIR, exist_ok=True)

# Setup Jinja2 environment
env = Environment(
    loader=FileSystemLoader(TEMPLATE_DIR),
    autoescape=select_autoescape(['html', 'xml'])
)


def get_db_connection():
    """Return a new connection to the SQLite database.

    Connections are created per request to avoid threading issues.  The
    connection uses row factory to return dictionaries for easier access.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Initialize the database with the clients table if it doesn't exist."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS clients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                phone TEXT,
                status TEXT NOT NULL DEFAULT 'Lead',
                follow_up_date TEXT,
                notes TEXT
            );
            """
        )
        conn.commit()


def render_template(template_name, **context):
    """Render a Jinja2 template with the provided context."""
    template = env.get_template(template_name)
    return template.render(**context).encode('utf-8')


def parse_post_data(environ):
    """Parse form data or JSON payload from a POST/PUT/PATCH request.

    Returns a tuple of (data, content_type) where data is a dictionary or
    object representing the parsed body and content_type indicates whether
    the payload was JSON or URL encoded form data.
    """
    try:
        request_body_size = int(environ.get('CONTENT_LENGTH', 0))
    except (ValueError, TypeError):
        request_body_size = 0
    body = environ['wsgi.input'].read(request_body_size)
    content_type = environ.get('CONTENT_TYPE', '') or ''
    if 'application/json' in content_type:
        try:
            data = json.loads(body.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            data = {}
        return data, 'json'
    else:
        # Assume form data
        parsed = parse_qs(body.decode('utf-8'))
        data = {k: v[0] if isinstance(v, list) else v for k, v in parsed.items()}
        return data, 'form'


def not_found(start_response):
    """Return a 404 Not Found response."""
    start_response('404 Not Found', [('Content-Type', 'text/plain')])
    return [b'Not Found']


def redirect(location, start_response):
    """Return a 302 redirect response to the specified location."""
    start_response('302 Found', [('Location', location)])
    return [b'']


def serve_static(environ, start_response):
    """Serve static files located in the static directory.

    This function reads the requested file from disk and returns it with
    an appropriate MIME type based on its extension.  If the file is not
    found, a 404 is returned.
    """
    # Remove leading '/static/' from path
    rel_path = environ['PATH_INFO'][len('/static/'):]
    file_path = os.path.join(STATIC_DIR, rel_path)
    if not os.path.isfile(file_path):
        return not_found(start_response)
    # Determine content type
    ext = os.path.splitext(file_path)[1].lower()
    if ext in ('.css',):
        content_type = 'text/css'
    elif ext in ('.js',):
        content_type = 'application/javascript'
    elif ext in ('.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico'):
        content_type = 'image/' + ext.lstrip('.')
    else:
        content_type = 'application/octet-stream'
    with open(file_path, 'rb') as f:
        data = f.read()
    start_response('200 OK', [('Content-Type', content_type)])
    return [data]


def handle_dashboard(environ, start_response):
    """Handle the dashboard page showing KPIs and status chart."""
    conn = get_db_connection()
    cursor = conn.cursor()
    # Compute counts by status
    cursor.execute("SELECT status, COUNT(*) as count FROM clients GROUP BY status")
    status_counts_raw = cursor.fetchall()
    status_counts = {row['status']: row['count'] for row in status_counts_raw}
    total_clients = sum(status_counts.values()) if status_counts else 0
    leads = status_counts.get('Lead', 0)
    active = status_counts.get('Active', 0)
    inactive = status_counts.get('Inactive', 0)
    # Overdue follow-ups: follow_up_date before today
    today_str = datetime.date.today().isoformat()
    cursor.execute(
        "SELECT COUNT(*) FROM clients WHERE follow_up_date IS NOT NULL AND follow_up_date < ?",
        (today_str,)
    )
    overdue_count = cursor.fetchone()[0]
    conn.close()
    # Prepare chart data for Chart.js (labels and values lists)
    chart_labels = list(status_counts.keys())
    chart_values = list(status_counts.values())
    body = render_template(
        'dashboard.html',
        total_clients=total_clients,
        leads=leads,
        active=active,
        inactive=inactive,
        overdue_count=overdue_count,
        chart_labels=json.dumps(chart_labels),
        chart_values=json.dumps(chart_values),
        request_path=environ.get('PATH_INFO', '/')
    )
    start_response('200 OK', [('Content-Type', 'text/html')])
    return [body]


def handle_clients_list(environ, start_response):
    """Handle the clients list page with filtering, sorting and searching."""
    query_params = parse_qs(environ.get('QUERY_STRING', ''))
    search_term = query_params.get('q', [''])[0].strip()
    status_filter = query_params.get('status', [''])[0]
    sort_by = query_params.get('sort', ['name'])[0]
    order = query_params.get('order', ['asc'])[0]
    conn = get_db_connection()
    cursor = conn.cursor()
    # Build query dynamically based on filters
    conditions = []
    params = []
    if search_term:
        conditions.append("(name LIKE ? OR email LIKE ?)")
        like_pattern = f"%{search_term}%"
        params.extend([like_pattern, like_pattern])
    if status_filter:
        conditions.append("status = ?")
        params.append(status_filter)
    where_clause = 'WHERE ' + ' AND '.join(conditions) if conditions else ''
    # Validate sort_by and order
    valid_sort_columns = {'name', 'email', 'phone', 'status', 'follow_up_date'}
    if sort_by not in valid_sort_columns:
        sort_by = 'name'
    order_clause = 'DESC' if order.lower() == 'desc' else 'ASC'
    query = f"SELECT * FROM clients {where_clause} ORDER BY {sort_by} {order_clause}"
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    conn.close()
    # Prepare client dictionaries with overdue flag
    today_str = datetime.date.today().isoformat()
    clients_data = []
    for r in rows:
        d = dict(r)
        follow_date = d.get('follow_up_date')
        overdue = False
        if follow_date:
            # Compare ISO formatted dates lexicographically
            overdue = follow_date < today_str
        d['overdue'] = overdue
        clients_data.append(d)
    # Render template
    body = render_template(
        'client_list.html',
        clients=clients_data,
        search_term=search_term,
        status_filter=status_filter,
        sort_by=sort_by,
        order=order,
        request_path=environ.get('PATH_INFO', '/')
    )
    start_response('200 OK', [('Content-Type', 'text/html')])
    return [body]


def handle_client_form(environ, start_response, client_id=None):
    """Render the client form for adding or editing clients.

    If ``client_id`` is provided, the existing record is fetched and used to
    populate the form.  On POST, the submitted data is validated and
    inserted or updated in the database.
    """
    method = environ['REQUEST_METHOD']
    conn = get_db_connection()
    cursor = conn.cursor()
    if method == 'POST':
        form_data, _ = parse_post_data(environ)
        # Extract and sanitize fields
        name = form_data.get('name', '').strip()
        email = form_data.get('email', '').strip()
        phone = form_data.get('phone', '').strip()
        status_val = form_data.get('status', 'Lead')
        follow_up_date = form_data.get('follow_up_date', '') or None
        notes = form_data.get('notes', '').strip()
        # Ensure required fields
        if name and email:
            if client_id is None:
                # Insert new client
                cursor.execute(
                    "INSERT INTO clients (name, email, phone, status, follow_up_date, notes) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (name, email, phone, status_val, follow_up_date, notes)
                )
            else:
                # Update existing client
                cursor.execute(
                    "UPDATE clients SET name=?, email=?, phone=?, status=?, follow_up_date=?, notes=? "
                    "WHERE id=?",
                    (name, email, phone, status_val, follow_up_date, notes, client_id)
                )
            conn.commit()
            conn.close()
            # Redirect to clients list after save
            return redirect('/clients', start_response)
    # GET or invalid POST: render form
    client = None
    if client_id is not None:
        cursor.execute("SELECT * FROM clients WHERE id=?", (client_id,))
        client = cursor.fetchone()
    conn.close()
    body = render_template(
        'client_form.html',
        client=client,
        is_edit=client_id is not None,
        request_path=environ.get('PATH_INFO', '/')
    )
    start_response('200 OK', [('Content-Type', 'text/html')])
    return [body]


def handle_client_delete(environ, start_response, client_id):
    """Handle deletion of a client record."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM clients WHERE id=?", (client_id,))
    conn.commit()
    conn.close()
    return redirect('/clients', start_response)


def handle_export_csv(environ, start_response):
    """Export the full client list to a CSV file."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM clients ORDER BY name ASC")
    clients = cursor.fetchall()
    conn.close()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['id', 'name', 'email', 'phone', 'status', 'follow_up_date', 'notes'])
    for row in clients:
        writer.writerow([
            row['id'], row['name'], row['email'], row['phone'], row['status'], row['follow_up_date'], row['notes']
        ])
    csv_data = output.getvalue().encode('utf-8')
    start_response('200 OK', [
        ('Content-Type', 'text/csv'),
        ('Content-Disposition', 'attachment; filename="clients.csv"')
    ])
    return [csv_data]


def handle_api_clients(environ, start_response):
    """Handle API requests to /api/clients for listing and creating clients."""
    method = environ['REQUEST_METHOD']
    conn = get_db_connection()
    cursor = conn.cursor()
    if method == 'GET':
        # Optional filters via query parameters
        query_params = parse_qs(environ.get('QUERY_STRING', ''))
        search_term = query_params.get('q', [''])[0].strip()
        status_filter = query_params.get('status', [''])[0]
        conditions = []
        params = []
        if search_term:
            conditions.append("(name LIKE ? OR email LIKE ?)")
            like_pattern = f"%{search_term}%"
            params.extend([like_pattern, like_pattern])
        if status_filter:
            conditions.append("status = ?")
            params.append(status_filter)
        where_clause = 'WHERE ' + ' AND '.join(conditions) if conditions else ''
        cursor.execute(f"SELECT * FROM clients {where_clause}", tuple(params))
        clients = cursor.fetchall()
        conn.close()
        clients_list = [dict(row) for row in clients]
        body = json.dumps(clients_list).encode('utf-8')
        start_response('200 OK', [('Content-Type', 'application/json')])
        return [body]
    elif method == 'POST':
        data, _ = parse_post_data(environ)
        # Expect JSON payload
        name = data.get('name', '').strip()
        email = data.get('email', '').strip()
        phone = data.get('phone', '').strip()
        status_val = data.get('status', 'Lead')
        follow_up_date = data.get('follow_up_date') or None
        notes = data.get('notes', '').strip()
        if not name or not email:
            start_response('400 Bad Request', [('Content-Type', 'application/json')])
            return [json.dumps({'error': 'name and email are required'}).encode('utf-8')]
        cursor.execute(
            "INSERT INTO clients (name, email, phone, status, follow_up_date, notes) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (name, email, phone, status_val, follow_up_date, notes)
        )
        conn.commit()
        new_id = cursor.lastrowid
        cursor.execute("SELECT * FROM clients WHERE id=?", (new_id,))
        new_client = dict(cursor.fetchone())
        conn.close()
        body = json.dumps(new_client).encode('utf-8')
        start_response('201 Created', [('Content-Type', 'application/json')])
        return [body]
    else:
        conn.close()
        start_response('405 Method Not Allowed', [('Allow', 'GET, POST')])
        return [b'']


def handle_api_client_detail(environ, start_response, client_id):
    """Handle API requests for a specific client record."""
    method = environ['REQUEST_METHOD']
    conn = get_db_connection()
    cursor = conn.cursor()
    if method == 'GET':
        cursor.execute("SELECT * FROM clients WHERE id=?", (client_id,))
        row = cursor.fetchone()
        conn.close()
        if row is None:
            start_response('404 Not Found', [('Content-Type', 'application/json')])
            return [json.dumps({'error': 'client not found'}).encode('utf-8')]
        body = json.dumps(dict(row)).encode('utf-8')
        start_response('200 OK', [('Content-Type', 'application/json')])
        return [body]
    elif method in ('PUT', 'PATCH'):
        data, _ = parse_post_data(environ)
        # Build update statement from provided fields
        fields = []
        params = []
        for field in ('name', 'email', 'phone', 'status', 'follow_up_date', 'notes'):
            if field in data:
                fields.append(f"{field}=?")
                params.append(data[field])
        if not fields:
            conn.close()
            start_response('400 Bad Request', [('Content-Type', 'application/json')])
            return [json.dumps({'error': 'no fields to update'}).encode('utf-8')]
        params.append(client_id)
        cursor.execute(
            f"UPDATE clients SET {', '.join(fields)} WHERE id=?",
            tuple(params)
        )
        conn.commit()
        cursor.execute("SELECT * FROM clients WHERE id=?", (client_id,))
        updated = dict(cursor.fetchone())
        conn.close()
        start_response('200 OK', [('Content-Type', 'application/json')])
        return [json.dumps(updated).encode('utf-8')]
    elif method == 'DELETE':
        cursor.execute("DELETE FROM clients WHERE id=?", (client_id,))
        conn.commit()
        conn.close()
        start_response('204 No Content', [])
        return [b'']
    else:
        conn.close()
        start_response('405 Method Not Allowed', [('Allow', 'GET, PUT, PATCH, DELETE')])
        return [b'']


def app(environ, start_response):
    """The WSGI application callable.

    Routes requests based on PATH_INFO and delegates to appropriate handlers.
    Static files under /static/ are served directly.  Unknown routes
    return a 404.
    """
    setup_testing_defaults(environ)
    path = environ.get('PATH_INFO', '')
    method = environ['REQUEST_METHOD']
    # Serve static files
    if path.startswith('/static/'):
        return serve_static(environ, start_response)
    # Route definitions
    # Home redirect
    if path == '/' and method == 'GET':
        return redirect('/dashboard', start_response)
    # Dashboard
    if path == '/dashboard' and method == 'GET':
        return handle_dashboard(environ, start_response)
    # Clients list
    if path == '/clients' and method == 'GET':
        return handle_clients_list(environ, start_response)
    # Add new client
    if path == '/clients/new':
        return handle_client_form(environ, start_response, client_id=None)
    # Edit or delete client using pattern matching
    if path.startswith('/clients/'):
        parts = path.strip('/').split('/')
        if len(parts) >= 2:
            try:
                client_id = int(parts[1])
            except ValueError:
                return not_found(start_response)
            # Edit form
            if len(parts) == 3 and parts[2] == 'edit':
                return handle_client_form(environ, start_response, client_id=client_id)
            # Delete
            if len(parts) == 3 and parts[2] == 'delete':
                return handle_client_delete(environ, start_response, client_id=client_id)
    # CSV export
    if path == '/clients/export' and method == 'GET':
        return handle_export_csv(environ, start_response)
    # API routes
    if path == '/api/clients':
        return handle_api_clients(environ, start_response)
    if path.startswith('/api/clients/'):
        try:
            client_id = int(path[len('/api/clients/'):])
        except ValueError:
            return not_found(start_response)
        return handle_api_client_detail(environ, start_response, client_id)
    # Fallback
    return not_found(start_response)


def run(host='0.0.0.0', port=5000):
    """Run the development server."""
    init_db()
    print(f"Starting Fortivo CRM on http://{host}:{port} ...")
    with make_server(host, port, app) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == '__main__':
    run()
