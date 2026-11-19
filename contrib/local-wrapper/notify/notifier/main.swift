// Posts a "Codebase Index" notification, optionally with one action button that runs a shell
// command. osascript notifications cannot carry buttons; this needs a real app bundle.
//
//   Codebase Index.app --title T [--body B] [--id ID] [--action-label L --action-command CMD]
//
// The command travels in the notification's userInfo, so a click after this process has exited
// still works: macOS relaunches the app without arguments and delivers the response.
import AppKit
import UserNotifications

let actionIdentifier = "run"
let categoryIdentifier = "ocbi"
let waitForClickSeconds = 6.0 * 3600

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == actionIdentifier,
           let command = response.notification.request.content.userInfo["command"] as? String {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = ["-c", command]
            try? process.run()
            process.waitUntilExit()
        }
        completionHandler()
        exit(0)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }
}

func option(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate()
let center = UNUserNotificationCenter.current()
center.delegate = delegate

if let title = option("--title") {
    let actionLabel = option("--action-label")
    let actionCommand = option("--action-command")
    let hasAction = actionLabel != nil && actionCommand != nil

    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        guard granted else {
            FileHandle.standardError.write(Data("notifications not authorized: \(error.map { "\($0)" } ?? "denied in System Settings")\n".utf8))
            exit(2)
        }
        let actions = hasAction
            ? [UNNotificationAction(identifier: actionIdentifier, title: actionLabel!, options: [])]
            : []
        center.setNotificationCategories([
            UNNotificationCategory(identifier: categoryIdentifier, actions: actions, intentIdentifiers: [], options: []),
        ])

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = option("--body") ?? ""
        content.sound = .default
        content.categoryIdentifier = categoryIdentifier
        if hasAction { content.userInfo = ["command": actionCommand!] }

        let request = UNNotificationRequest(identifier: option("--id") ?? UUID().uuidString, content: content, trigger: nil)
        center.add(request) { error in
            if error != nil { exit(1) }
            let linger = hasAction ? waitForClickSeconds : 2
            DispatchQueue.main.asyncAfter(deadline: .now() + linger) { exit(0) }
        }
    }
} else {
    // Relaunched by a click on an earlier notification; the response arrives right after launch.
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { exit(0) }
}

app.run()
