import { cn } from "@/lib/utils"

// Inline copy of app/icon.svg, cropped to the silhouette. Black follows the
// text color and white the page background, so the mark inverts in dark mode.
export function CatteryLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="157 156 940 940" aria-hidden className={cn("text-foreground", className)}>
      <path
        fill="currentColor"
        d="M254 1058C198 1058 159 1020 159 962V488C159 473 161 458 165 443L215 264C225 225 249 198 278 196C304 194 326 204 346 225L440 332H812L908 225C928 204 950 194 976 196C1005 198 1029 225 1039 264L1089 443C1093 458 1095 473 1095 488V962C1095 1020 1056 1058 1000 1058Z"
      />
      <path
        className="fill-background"
        d="M635 377H838C845 377 849 373 855 367L956 274C966 264 981 263 989 274C993 280 996 290 999 303L1043 466C1045 474 1045 481 1045 489V954C1045 995 1024 1018 984 1018H620C660 994 685 958 685 905L682 486C682 445 666 405 635 377Z"
      />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path className="stroke-background" strokeWidth={62} d="M296 636L412 714L294 790" />
        <path className="stroke-background" strokeWidth={52} d="M449 819H579" />
        <path stroke="currentColor" strokeWidth={62} d="M941 640L805 724L941 813" />
      </g>
    </svg>
  )
}
