import { BrandLogo } from "@/components/portal/brand-logo";
import { Toaster } from "@/components/ui/toaster";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="area-portal flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-screen py-10">
      <BrandLogo variant="full" />
      {children}
      <Toaster />
    </div>
  );
}
