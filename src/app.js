const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config/env');
const healthRoute = require('./routes/health.route');
const invitationsRoute = require('./routes/invitations.route');
const authRoute = require('./routes/auth.route');
const videosRoute = require('./routes/videos.route');
const commentsRoute = require('./routes/comments.route');
const messagesRoute = require('./routes/messages.route');
const dashboardRoute = require('./routes/dashboard.route');
const notificationsRoute = require('./routes/notifications.route');
const tasksRoute = require('./routes/tasks.route');
const availabilityRoute = require('./routes/availability.route');
const availabilityExceptionsRoute = require('./routes/availabilityExceptions.route');
const bookingsRoute = require('./routes/bookings.route');
const studentsRoute = require('./routes/students.route');
const libraryRoute = require('./routes/library.route');
const organizationRoute = require('./routes/organization.route');
const broadcastsRoute = require('./routes/broadcasts.route');
const coursesRoute = require('./routes/courses.route');
const assignmentsRoute = require('./routes/assignments.route');
const submissionsRoute = require('./routes/submissions.route');

const app = express();

// Production runs behind Caddy on the same VPS (reverse_proxy localhost:{$PORT}),
// a single hop from loopback. Trusting only loopback means X-Forwarded-For is
// honored solely when the request truly comes from that proxy, so
// express-rate-limit's IP-based keying reflects real client IPs instead of
// bucketing every user under the proxy's own loopback address.
app.set('trust proxy', 'loopback');

app.use(
  helmet({
    hsts: { maxAge: 15552000, includeSubDomains: true },
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        // Permits embedding the Jitsi Meet IFrame API (Phase 7).
        'frame-src': ["'self'", 'https://meet.jit.si'],
        'script-src': ["'self'", 'https://meet.jit.si']
      }
    }
  })
);

app.use(
  cors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // Required so the browser sends/receives the httpOnly refresh-token
    // cookie cross-origin between the Vite dev origin and this API origin.
    credentials: true
  })
);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.use('/api/health', healthRoute);
app.use('/invitations', invitationsRoute);
app.use('/auth', authRoute);
app.use('/videos', videosRoute);
app.use('/videos/:id/comments', commentsRoute);
app.use('/messages', messagesRoute);
app.use('/dashboard', dashboardRoute);
app.use('/notifications', notificationsRoute);
app.use('/tasks', tasksRoute);
app.use('/availability', availabilityRoute);
app.use('/availability-exceptions', availabilityExceptionsRoute);
app.use('/bookings', bookingsRoute);
app.use('/students', studentsRoute);
app.use('/library', libraryRoute);
app.use('/organization', organizationRoute);
app.use('/broadcasts', broadcastsRoute);
app.use('/courses', coursesRoute);
app.use('/courses/:courseId/assignments', assignmentsRoute);
// Mounted at the root rather than under a prefix, because it serves two
// resource families: /assignments/:id/submissions (submitting and listing
// against an assignment) and /submissions/:id (one attempt, its files, and the
// review). Nesting the second under the first would put a submission's id
// behind an assignment id the client already resolved, for no gain -- the
// scope check reads the parent chain from the row either way.
app.use('/', submissionsRoute);

// Fallback error handler — must be last, must have 4 args.
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  const status = err.status || err.statusCode || 500;
  const message =
    status === 500 ? 'Internal server error' : err.message || 'Request error';
  res.status(status).json({ status: 'error', message });
});

module.exports = app;
