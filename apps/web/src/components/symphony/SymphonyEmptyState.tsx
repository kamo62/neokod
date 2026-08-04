import type { LucideIcon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";

export function SymphonyEmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <Icon className="size-4.5 text-muted-foreground" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
