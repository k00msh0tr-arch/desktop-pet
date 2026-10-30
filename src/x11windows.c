// Reads the position of the visible top-level windows on X11 so the pet can stand on them and climb them: the Linux
// counterpart of src/windows.js. It only reads geometry: no titles, no content.
//   cc -O2 -o claude-pet-windows src/x11windows.c -lX11
//   claude-pet-windows <pet pid> <interval ms>
// Prints one line per poll, front-most window first, in physical screen pixels:
//   id,x,y,w,h,fg;id,x,y,w,h,fg;...        (fg is 1 for the focused window)
// It stops when whoever reads it goes away (SIGPIPE) or the X server does.

#include <X11/Xlib.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static Display *dpy;

static int ignore_error(Display *d, XErrorEvent *e) { (void)d; (void)e; return 0; } // a window vanished mid-poll

static Atom atom(const char *name) { return XInternAtom(dpy, name, False); }

// The values of a 32-bit property (Xlib hands each one over as a long), or NULL. Free with XFree.
static long *prop(Window w, Atom name, unsigned long *n) {
  Atom type;
  int fmt;
  unsigned long left;
  unsigned char *data = NULL;
  *n = 0;
  if (XGetWindowProperty(dpy, w, name, 0, 1024, False, AnyPropertyType, &type, &fmt, n, &left, &data) != Success || !data) return NULL;
  if (fmt != 32 || !*n) { XFree(data); return NULL; }
  return (long *)data;
}

// the first value of a property as an unsigned 32-bit number, or -1 if there is none
static long cardinal(Window w, Atom name) {
  unsigned long n;
  long *v = prop(w, name, &n);
  long out = -1;
  if (v) { out = (long)((unsigned long)v[0] & 0xFFFFFFFFUL); XFree(v); }
  return out;
}

static int has(Window w, Atom name, Atom want) {
  unsigned long n, i;
  long *v = prop(w, name, &n);
  int found = 0;
  if (!v) return 0;
  for (i = 0; i < n; i++) if ((Atom)v[i] == want) found = 1;
  XFree(v);
  return found;
}

// left, right, top, bottom
static int extents(Window w, Atom name, long out[4]) {
  unsigned long n;
  long *v = prop(w, name, &n);
  int i, ok = v && n >= 4;
  if (ok) for (i = 0; i < 4; i++) out[i] = v[i];
  if (v) XFree(v);
  return ok;
}

int main(int argc, char **argv) {
  long pet = argc > 1 ? atol(argv[1]) : 0;
  int ms = argc > 2 ? atoi(argv[2]) : 120;
  if (!(dpy = XOpenDisplay(NULL))) { fprintf(stderr, "claude-pet-windows: cannot open the X display\n"); return 1; }
  XSetErrorHandler(ignore_error);

  Window root = DefaultRootWindow(dpy);
  Atom stacking = atom("_NET_CLIENT_LIST_STACKING"), clients = atom("_NET_CLIENT_LIST"), active = atom("_NET_ACTIVE_WINDOW"),
       current = atom("_NET_CURRENT_DESKTOP"), desktop = atom("_NET_WM_DESKTOP"), state = atom("_NET_WM_STATE"),
       hidden = atom("_NET_WM_STATE_HIDDEN"), skip = atom("_NET_WM_STATE_SKIP_TASKBAR"), type = atom("_NET_WM_WINDOW_TYPE"),
       normal = atom("_NET_WM_WINDOW_TYPE_NORMAL"), dialog = atom("_NET_WM_WINDOW_TYPE_DIALOG"), frame = atom("_NET_FRAME_EXTENTS"),
       gtk = atom("_GTK_FRAME_EXTENTS"), owner = atom("_NET_WM_PID");

  for (;;) {
    unsigned long n = 0, i, na, nt;
    int first = 1;
    long *act = prop(root, active, &na);
    Window fg = act ? (Window)act[0] : None;
    long cur = cardinal(root, current);
    long *wins = prop(root, stacking, &n);
    if (act) XFree(act);
    if (!wins) wins = prop(root, clients, &n);

    for (i = n; wins && i-- > 0;) { // the list runs bottom to top
      Window w = (Window)wins[i], child;
      XWindowAttributes a;
      long ext[4], d, *t;
      int x, y, wd, ht, plain;

      if (!XGetWindowAttributes(dpy, w, &a) || a.map_state != IsViewable) continue; // minimised windows are not mapped
      if (has(w, state, hidden) || has(w, state, skip)) continue;                    // her own overlay skips the taskbar
      if (cardinal(w, owner) == pet) continue;
      t = prop(w, type, &nt);
      plain = !t || (Atom)t[0] == normal || (Atom)t[0] == dialog; // not a dock, desktop, tooltip, toolbar, ...
      if (t) XFree(t);
      if (!plain) continue;
      d = cardinal(w, desktop);
      if (cur >= 0 && d >= 0 && d != 0xFFFFFFFFL && d != cur) continue; // on another workspace (0xFFFFFFFF: on all)

      if (!XTranslateCoordinates(dpy, w, root, 0, 0, &x, &y, &child)) continue;
      wd = a.width;
      ht = a.height;
      // the visible frame: add the title bar and borders the window manager draws, or take off the shadow a GTK
      // window draws for itself
      if (extents(w, gtk, ext)) { x += ext[0]; y += ext[2]; wd -= ext[0] + ext[1]; ht -= ext[2] + ext[3]; }
      else if (extents(w, frame, ext)) { x -= ext[0]; y -= ext[2]; wd += ext[0] + ext[1]; ht += ext[2] + ext[3]; }
      if (wd < 120 || ht < 40) continue;
      printf("%s%lu,%d,%d,%d,%d,%d", first ? "" : ";", (unsigned long)w, x, y, wd, ht, w == fg);
      first = 0;
    }
    if (wins) XFree(wins);
    putchar('\n');
    if (fflush(stdout) == EOF) return 0;
    usleep((useconds_t)ms * 1000);
  }
}
