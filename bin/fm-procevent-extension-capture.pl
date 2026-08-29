use strict;
use warnings;
use Cwd qw(getcwd);
use Digest::SHA qw(sha256_hex);
use Fcntl qw(O_CREAT O_EXCL O_NOFOLLOW O_RDWR);

my ($registry_fd, $inbox_fd, $id, $adapter, $extension_id, $extension_version, $capability_version,
    $package_digest, $binding_digest, $claim_token, $runner_name, $output_name,
    $runner_pid, $limit, @command) = @ARGV;
die "missing command\n" unless @command && shift(@command) eq "--";
die "invalid limit\n" unless defined $limit && $limit =~ /\A\d+\z/;

sub fail { die "capture failed: $_[0]\n"; }
sub safe_dir {
  my ($path, $mode) = @_;
  my @st = lstat($path);
  return 0 unless @st && -d _ && !-l _ && $st[4] == $<;
  return 0 unless ($st[2] & 0022) == 0;
  return 0 if defined $mode && ($st[2] & 07777) != $mode;
  return 1;
}
sub open_new {
  my ($name) = @_;
  sysopen(my $fh, $name, O_CREAT | O_EXCL | O_NOFOLLOW | O_RDWR, 0600)
    or fail("cannot create $name");
  return $fh;
}
sub write_all {
  my ($fh, $value) = @_;
  my $offset = 0;
  while ($offset < length $value) {
    my $written = syswrite($fh, $value, length($value) - $offset, $offset);
    defined $written && $written > 0 or fail("cannot write evidence");
    $offset += $written;
  }
}
sub copy_all {
  my ($from, $to) = @_;
  while (1) {
    my $read = sysread($from, my $buffer, 65536);
    defined $read or fail("cannot read staged output");
    last if $read == 0;
    write_all($to, $buffer);
  }
}
sub publish_new {
  my ($temporary, $final) = @_;
  link($temporary, $final) or fail("cannot publish $final");
  unlink($temporary) or fail("cannot remove temporary evidence");
}

open(my $registry_dir, "<&=$registry_fd") or fail("cannot retain registry directory");
chdir($registry_dir) or fail("cannot enter registry directory");
safe_dir(".", 0700) or fail("unsafe registry directory");
my $registry = getcwd();
open(my $inbox_dir, "<&=$inbox_fd") or fail("cannot retain inbox directory");
chdir($inbox_dir) or fail("cannot enter inbox directory");
safe_dir(".", 0700) or fail("unsafe inbox directory");
open(my $authority, "<&=7") or fail("cannot retain capture authority");
my $authority_bytes = "";
while (1) {
  my $read = sysread($authority, my $buffer, 32 - length($authority_bytes));
  defined $read or fail("cannot read capture authority");
  last if $read == 0;
  $authority_bytes .= $buffer;
}
length($authority_bytes) == 32 or fail("invalid capture authority");
my $authority_digest = sha256_hex($authority_bytes);
chdir($registry_dir) or fail("cannot return to registry directory");
getcwd() eq $registry or fail("registry directory changed");
my $runner = open_new($runner_name);
write_all($runner, "$runner_pid\n");
close($runner) or fail("cannot close runner record");
my $stage = open_new($output_name);
pipe(my $reader, my $writer) or fail("cannot create output pipe");
my $child = fork();
defined $child or fail("cannot fork adapter");
if ($child == 0) {
  close($reader);
  open(STDOUT, ">&", $writer) or exit 126;
  open(STDERR, ">", "/dev/null") or exit 126;
  exec @command;
  exit 127;
}
close($writer);
my ($written, $truncated) = (0, 0);
while (1) {
  my $read = sysread($reader, my $buffer, 65536);
  defined $read or fail("cannot read adapter output");
  last if $read == 0;
  my $take = $written < $limit ? $limit - $written : 0;
  $take = $read if $take > $read;
  if ($take > 0) {
    write_all($stage, substr($buffer, 0, $take));
    $written += $take;
  }
  $truncated = 1 if $take < $read;
}
close($reader);
my $waited = waitpid($child, 0);
my $status = $?;
if ($waited != $child || ($status & 127)) {
  close($stage);
  unlink($output_name);
  unlink($runner_name);
  print "failure\t$truncated\n";
  exit 0;
}
my $rc = $status >> 8;
if ($rc != 0 && $written == 0) {
  unlink($output_name);
  unlink($runner_name);
  print "no-result\t$rc\t$truncated\n";
  exit 0;
}
chdir($inbox_dir) or fail("cannot enter inbox directory");
my $sequence = 1;
$sequence++ while -e "$id.$sequence.result" || -l "$id.$sequence.result";
my $prefix = "$id.$sequence";
my $nonce = ".$prefix.$$";
my $result_tmp = "$nonce.result";
my $adapter_tmp = "$nonce.adapter";
my $extension_tmp = "$nonce.extension";
my $authority_tmp = "$nonce.authority";
my $result = open_new($result_tmp);
seek($stage, 0, 0) or fail("cannot rewind staged output");
copy_all($stage, $result);
close($result) or fail("cannot close result");
my $adapter_file = open_new($adapter_tmp);
write_all($adapter_file, "$adapter\n");
close($adapter_file) or fail("cannot close adapter evidence");
my $extension_file = open_new($extension_tmp);
write_all($extension_file, join("\n", "schema=fm-procevent-extension-owner.v1", "extension_id=$extension_id", "extension_version=$extension_version", "capability_version=$capability_version", "package_digest=$package_digest", "binding_digest=$binding_digest", ""));
close($extension_file) or fail("cannot close extension evidence");
my $authority_file = open_new($authority_tmp);
write_all($authority_file, "sha256:$authority_digest\n");
close($authority_file) or fail("cannot close capture authority");
publish_new($adapter_tmp, "$prefix.adapter");
publish_new($extension_tmp, "$prefix.extension");
publish_new($authority_tmp, "$prefix.authority");
publish_new($result_tmp, "$prefix.result");
close($stage) or fail("cannot close staged output");
chdir($registry_dir) or fail("cannot return to registry directory");
unlink($output_name) or fail("cannot remove staged output");
unlink($runner_name) or fail("cannot remove runner record");
print "captured\t$prefix.result\t$rc\t$truncated\n";
