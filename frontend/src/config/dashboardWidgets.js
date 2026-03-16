import MyAttendanceWidget from "@/components/dashboard/widgets/MyAttendanceWidget"
import MyLeaveWidget from "@/components/dashboard/widgets/MyLeaveWidget"
import MyTasksWidget from "@/components/dashboard/widgets/MyTasksWidget"
import MyApprovalsWidget from "@/components/dashboard/widgets/MyApprovalsWidget"
import MyPayslipsWidget from "@/components/dashboard/widgets/MyPayslipsWidget"
import AnnouncementsWidget from "@/components/dashboard/widgets/AnnouncementsWidget"
import ActivityWidget from "@/components/dashboard/widgets/ActivityWidget"

export const widgetRegistry = {
  attendance: MyAttendanceWidget,
  leave: MyLeaveWidget,
  tasks: MyTasksWidget,
  approvals: MyApprovalsWidget,
  payslips: MyPayslipsWidget,
  announcements: AnnouncementsWidget,
  activity: ActivityWidget
}