namespace TokenTrackerWin;

internal static class Program
{
    // Stable per-user mutex name so a second launch just exits.
    private const string SingleInstanceMutexName = "TokenTracker.Windows.Tray.SingleInstance";

    [STAThread]
    private static void Main(string[] args)
    {
        var launchedAtStartup = args.Any(a =>
            string.Equals(a, LaunchAtStartup.StartupArgument, StringComparison.OrdinalIgnoreCase));
        Diag.Log("program", $"Main argc={args.Length} startup={launchedAtStartup}");

        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out var isNew);
        Diag.Log("program", $"mutex isNew={isNew}");
        if (!isNew)
        {
            // Already running: a second copy must exit (single-instance app).
            return;
        }

        // A WPF Application instance gives the (WPF) dashboard window its resource /
        // dispatcher context. We never call its Run(); the WinForms message pump below
        // drives the shared STA thread (and the WPF Dispatcher rides on it). Explicit
        // shutdown mode so WPF doesn't tear itself down when the window is hidden.
        _ = new System.Windows.Application { ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown };

        ApplicationConfiguration.Initialize();
        // Show the desktop pet on a normal launch (manual run or post-install), but stay
        // quietly in the tray when Windows auto-starts us at login (the pet then
        // restores only if it was open last exit). The dashboard no longer auto-opens —
        // the pet is the visible presence.
        var showPetOnLaunch = !launchedAtStartup;
        var ctx = new TrayApplicationContext(showPetOnLaunch);

        Application.Run(ctx);

        GC.KeepAlive(mutex);
    }
}
