import { BrandLogo } from "@/components/portal/brand-logo";
import { Toaster } from "@/components/ui/toaster";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="area-portal flex min-h-screen flex-col bg-background">
      <header className="flex justify-center bg-brand-deep px-screen py-5 md:py-8">
        <BrandLogo variant="full" tone="light" />
      </header>
      <div className="flex flex-1 flex-col items-center justify-center px-screen py-6 md:py-10">
        {children}
      </div>
      <Toaster />
    </div>
  );
}
