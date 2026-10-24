import { BrandLogo } from "@/components/portal/brand-logo";
import { Toaster } from "@/components/ui/toaster";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="area-portal flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/40 p-4">
      <BrandLogo variant="full" />
      {children}
      <Toaster />
    </div>
  );
}
