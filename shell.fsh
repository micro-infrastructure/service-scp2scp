#!/usr/bin/fish
set UC $argv[1]
set CNT $argv[2]
if [ "$CNT" ]
	echo $CNT
else
	set CNT 'scp'
end
kubectl exec -it (kubectl get pods -n $UC | grep micro | awk '{print $1}') -n $UC -c $CNT sh
